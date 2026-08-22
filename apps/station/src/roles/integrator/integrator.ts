/**
 * @agent-trade/station — integrator role core (module S4).
 *
 * Thin orchestration: fetch/verify member LISTING_REFs → synthesize + sign the
 * topic catalog LISTING_REF → (optionally) re-seed + archive member catalogs →
 * announce to indexer stations. Old signed files are never overwritten:
 * `store.putObject` writes each object_id to its own immutable fact file, so a
 * refresh with changed content naturally leaves the previous LISTING_REF in
 * place.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { catalogHash, download, seed } from '@agent-trade/bt-catalog';
import type { SeedResult } from '@agent-trade/bt-catalog';
import { addSignature, buildObject, serialize } from '@agent-trade/signed-files';

import type { StationContext } from '../../types.js';
import { announceListingRef } from '../publisher/announce.js';
import { buildTopicCatalog } from './catalog.js';
import { parseIntegratorConfig } from './config.js';
import { buildResolveKey, loadMember, partitionMembers } from './members.js';
import type { CatalogArchive, IntegratorConfig, IntegratorHandle, RefreshResult, ReseedOutcome } from './types.js';

interface SeederState {
  seeder: SeedResult;
  catalogHash: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

export class Integrator {
  private readonly config: IntegratorConfig;
  private httpBase: string;
  private server: Server | null = null;
  private boundPort = 0;
  private result: RefreshResult | null = null;
  /** catalog_hash → archive (topic catalog + re-seeded member catalogs). */
  private readonly archives = new Map<string, CatalogArchive>();
  private seeders: SeederState[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly ctx: StationContext) {
    this.config = parseIntegratorConfig(ctx.config.integrator);
    this.httpBase = this.urlFor(ctx.config.http.port);
  }

  private urlFor(port: number): string {
    const host = this.ctx.config.http.host === '0.0.0.0' || this.ctx.config.http.host === '::'
      ? '127.0.0.1'
      : this.ctx.config.http.host;
    return `http://${host}:${port}`;
  }

  /**
   * Full pipeline: fetch/verify members → synthesize topic catalog → sign
   * LISTING_REF → store → (reseed members) → announce. Failures in member
   * fetch/verify are excluded + logged, not thrown; announce failures only log.
   */
  async refresh(): Promise<RefreshResult> {
    const resolveKey = buildResolveKey(this.ctx);

    const results = await Promise.all(this.config.members.map((ref) => loadMember(ref, this.ctx, resolveKey)));
    const { members, rejected } = partitionMembers(results);
    for (const r of rejected) {
      this.ctx.logger('warn', 'member rejected', { ref: r.ref, reason: r.reason });
    }

    const topic = buildTopicCatalog({
      agentId: this.ctx.agentId,
      theme: this.config.theme,
      tags: this.config.tags,
      members,
    });

    const body = {
      publisher: this.ctx.agentId,
      catalog_id: topic.catalog_id,
      item_id: topic.item_id,
      item_revision: 0,
      catalog_hash: topic.catalogHash,
      distribution_refs: [
        { type: 'https', uri: `${this.httpBase}/catalog` },
        { type: 'https', uri: `${this.httpBase}/catalogs/${topic.catalogHash}` },
      ],
    };

    const listingRef = addSignature(buildObject('LISTING_REF', body), this.ctx.agentId, this.ctx.secretKey);
    const objectId = this.ctx.store.putObject(listingRef);

    // Publish the topic catalog archive on the HTTP mirror.
    this.archives.set(topic.catalogHash, topic.archive);

    // Re-seed member catalogs (reseed: true): download → verify hash → archive
    // → re-seed. Never throws; each failure is logged and skipped.
    const reseed = this.config.reseed ? await this.reseedMembers(members) : [];

    const result: RefreshResult = {
      objectId,
      catalogHash: topic.catalogHash,
      listingRef,
      archive: topic.archive,
      members: topic.members,
      rejected,
      reseed,
    };
    this.result = result;

    this.ctx.logger('info', 'topic catalog refreshed', {
      object_id: objectId,
      catalog_hash: topic.catalogHash,
      theme: this.config.theme,
      tags: this.config.tags,
      members: members.length,
      rejected: rejected.length,
    });
    return result;
  }

  /** Download + archive + re-seed every member with a magnet distribution ref. */
  private async reseedMembers(members: { publisher: string; catalog_hash: string; magnetURI?: string }[]): Promise<ReseedOutcome[]> {
    // Drop the previous seeder set before re-seeding (re-hash on change).
    await this.stopSeeders();

    const outcomes: ReseedOutcome[] = [];
    for (const member of members) {
      const outcome: ReseedOutcome = {
        publisher: member.publisher,
        catalog_hash: member.catalog_hash,
        magnetURI: null,
        infoHash: null,
      };
      if (member.magnetURI === undefined) {
        outcome.error = 'no magnet distribution ref';
        this.ctx.logger('warn', 'reseed skipped', { publisher: member.publisher, reason: outcome.error });
        outcomes.push(outcome);
        continue;
      }

      const hex = member.catalog_hash.slice('sha256:'.length);
      const destDir = join(this.ctx.dataDir, 'reseed', hex);
      try {
        // Re-download from scratch each refresh (idempotent for identical content).
        await rm(destDir, { recursive: true, force: true });
        const manifest = await download(member.magnetURI, destDir, {
          tracker: this.config.trackers,
          dht: this.config.dht,
        });
        const hash = catalogHash(manifest);
        if (hash !== member.catalog_hash) {
          outcome.error = `catalog_hash mismatch: downloaded ${hash}`;
          this.ctx.logger('error', 'reseed hash mismatch', {
            publisher: member.publisher,
            expected: member.catalog_hash,
            got: hash,
          });
          outcomes.push(outcome);
          continue;
        }

        // Archive mirror (M8-compatible), byte-identical to the member's own
        // served archive.
        const files: { path: string; content: string }[] = [];
        for (const entry of manifest.files) {
          const data = new Uint8Array(await readFile(join(destDir, entry.path)));
          files.push({ path: entry.path, content: Buffer.from(data).toString('base64') });
        }
        this.archives.set(member.catalog_hash, { manifest, files });

        // Re-seed the downloaded directory (relay + archive). WebTorrent seeds
        // a directory with basename-prefixed torrent paths, so re-seed the
        // single top-level directory the torrent carried (e.g. dest/catalog-a)
        // to reproduce identical paths → identical catalog_hash.
        const firstSegments = new Set(manifest.files.map((f) => f.path.split('/')[0]!));
        const seedRoot = firstSegments.size === 1 ? join(destDir, [...firstSegments][0]!) : destDir;
        const seeder = await seed(seedRoot, { tracker: this.config.trackers, dht: this.config.dht });
        this.seeders.push({ seeder, catalogHash: member.catalog_hash });
        outcome.magnetURI = seeder.magnetURI;
        outcome.infoHash = seeder.infoHash;
        this.ctx.logger('info', 'member reseeded', {
          publisher: member.publisher,
          catalog_hash: member.catalog_hash,
        });
        outcomes.push(outcome);
      } catch (err) {
        outcome.error = err instanceof Error ? err.message : String(err);
        this.ctx.logger('warn', 'reseed failed', {
          publisher: member.publisher,
          catalog_hash: member.catalog_hash,
          error: outcome.error,
        });
        outcomes.push(outcome);
      }
    }
    return outcomes;
  }

  /** Announce the current LISTING_REF to every `announce_to`; never throws. */
  async announce(): Promise<void> {
    if (!this.result) return;
    if (this.config.announce_to.length === 0) return;
    try {
      await announceListingRef(this.result.listingRef, this.config.announce_to, {
        timeoutMs: this.config.announce_timeout_ms,
        retries: this.config.announce_retries,
        log: this.ctx.logger,
      });
    } catch (err) {
      this.ctx.logger('warn', 'announce errored', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async start(): Promise<IntegratorHandle> {
    // Register our own public key so store.putObject can verify our signature
    // (M3 trust ring resolves signers from saved keys).
    this.ctx.store.saveKey(this.ctx.agentId, this.ctx.secretKey);

    await this.startServer();
    try {
      await this.refresh();
      await this.announce();
    } catch (err) {
      await this.closeServer();
      throw err;
    }

    if (this.config.refresh_interval_ms !== null) {
      this.startTimer(this.config.refresh_interval_ms);
    }

    return {
      port: this.boundPort,
      refresh: () => this.refresh(),
      current: () => this.result,
      stop: () => this.stop(),
    };
  }

  private startServer(): Promise<void> {
    return new Promise<void>((resolveListen, rejectListen) => {
      const server = createServer((req, res) => void this.handleRequest(req, res));
      this.server = server;
      const onError = (err: Error): void => rejectListen(err);
      server.once('error', onError);
      server.listen(this.ctx.config.http.port, this.ctx.config.http.host, () => {
        server.off('error', onError);
        const address = server.address();
        this.boundPort =
          typeof address === 'object' && address !== null ? (address as AddressInfo).port : this.ctx.config.http.port;
        // Recompute the fallback base with the actual bound port (handles port 0).
        this.httpBase = this.urlFor(this.boundPort);
        resolveListen();
      });
      server.on('error', (err) => {
        this.ctx.logger('error', 'integrator http server error', { error: String(err) });
      });
    });
  }

  private closeServer(): Promise<void> {
    return new Promise<void>((resolveClose) => {
      const server = this.server;
      this.server = null;
      if (!server) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, role: 'integrator', agentId: this.ctx.agentId });
      return;
    }

    if (url.pathname === '/catalog') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!this.result) {
        sendJson(res, 404, { error: 'no catalog synthesized' });
        return;
      }
      sendJson(res, 200, this.result.archive);
      return;
    }

    if (url.pathname === '/listing-ref') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!this.result) {
        sendJson(res, 404, { error: 'no listing published' });
        return;
      }
      sendJson(res, 200, serialize(this.result.listingRef));
      return;
    }

    if (url.pathname === '/refresh') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      try {
        const result = await this.refresh();
        await this.announce();
        sendJson(res, 200, {
          status: 'refreshed',
          object_id: result.objectId,
          catalog_hash: result.catalogHash,
          members: result.members.length,
          rejected: result.rejected.length,
        });
      } catch (err) {
        sendJson(res, 500, {
          error: 'refresh_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const catalogMatch = url.pathname.match(/^\/catalogs\/([^/]+)$/);
    if (req.method === 'GET' && catalogMatch) {
      const hash = decodeURIComponent(catalogMatch[1]!);
      const archive = this.archives.get(hash);
      if (archive === undefined) {
        sendJson(res, 404, { error: 'catalog_not_found', catalog_hash: hash });
        return;
      }
      sendJson(res, 200, archive);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  private startTimer(intervalMs: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.timerTick();
    }, intervalMs);
  }

  private async timerTick(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.refresh();
      await this.announce();
    } catch (err) {
      this.ctx.logger('error', 'refresh tick failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async stopSeeders(): Promise<void> {
    for (const { seeder } of this.seeders.splice(0)) {
      try {
        await seeder.stop();
      } catch (err) {
        this.ctx.logger('warn', 'seeder stop failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.stopSeeders();
    await this.closeServer();
  }
}
