/**
 * @agent-trade/station — publisher role core (module S3).
 *
 * Thin orchestration: catalog directory → canonical manifest + catalog_hash
 * (M4) → signed LISTING_REF (M2) → WebTorrent seeding + HTTP fallback → announce
 * to indexer stations. Old signed files are never overwritten: `store.putObject`
 * writes each object_id to its own immutable fact file, so a re-publish with
 * changed content naturally leaves the previous LISTING_REF in place.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { catalogHash, seed } from '@agent-trade/bt-catalog';
import type { SeedResult } from '@agent-trade/bt-catalog';
import { addSignature, buildObject, serialize } from '@agent-trade/signed-files';

import type { StationContext } from '../../types.js';
import { announceListingRef } from './announce.js';
import { buildCatalogArchive, buildCatalogManifest, parseCatalogMetadata, readCatalogDir } from './catalog.js';
import { parsePublisherConfig } from './config.js';
import type { AnnounceResult, CatalogArchive, PublisherConfig, PublisherHandle, PublishResult } from './types.js';

interface PublishState {
  result: PublishResult;
  seeder: SeedResult;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

export class Publisher {
  private readonly config: PublisherConfig;
  private readonly catalogDir: string;
  private httpBase: string;
  private server: Server | null = null;
  private boundPort = 0;
  private state: PublishState | null = null;
  /** catalog_hash → archive, covering every version published this process. */
  private readonly archives = new Map<string, CatalogArchive>();
  private watchTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly ctx: StationContext) {
    this.config = parsePublisherConfig(ctx.config.publisher);
    this.catalogDir = resolve(this.config.catalog_dir);
    this.httpBase = this.urlFor(ctx.config.http.port);
  }

  private urlFor(port: number): string {
    const host = this.ctx.config.http.host === '0.0.0.0' || this.ctx.config.http.host === '::'
      ? '127.0.0.1'
      : this.ctx.config.http.host;
    return `http://${host}:${port}`;
  }

  /**
   * Full publish pipeline: read → manifest/hash → (re-)seed → sign LISTING_REF
   * → store. Does not announce (call {@link announce} separately).
   */
  async publish(): Promise<PublishResult> {
    const entries = await readCatalogDir(this.catalogDir);
    const manifest = buildCatalogManifest(entries);
    const hash = catalogHash(manifest);
    const metadata = parseCatalogMetadata(entries);
    const archive = buildCatalogArchive(entries, manifest);

    // Stop the previous seeder before re-seeding (re-hash on change). The old
    // LISTING_REF fact file stays in the store; only the live seeder is replaced.
    if (this.state) {
      await this.state.seeder.stop();
      this.state = null;
    }

    const seeder = await seed(this.catalogDir, { tracker: this.config.trackers, dht: this.config.dht });

    const body = {
      publisher: this.ctx.agentId,
      catalog_id: metadata.catalog_id,
      item_id: metadata.item_id,
      item_revision: metadata.item_revision,
      catalog_hash: hash,
      distribution_refs: [
        { type: 'magnet', uri: seeder.magnetURI },
        { type: 'https', uri: `${this.httpBase}/catalogs/${hash}` },
      ],
    };

    const listingRef = addSignature(buildObject('LISTING_REF', body), this.ctx.agentId, this.ctx.secretKey);
    const objectId = this.ctx.store.putObject(listingRef);

    const result: PublishResult = {
      catalogHash: hash,
      objectId,
      listingRef,
      magnetURI: seeder.magnetURI,
      torrentFile: seeder.torrentFile,
      tags: metadata.tags,
      archive,
    };
    this.state = { result, seeder };
    this.archives.set(hash, archive);

    this.ctx.logger('info', 'catalog published', {
      catalog_hash: hash,
      object_id: objectId,
      catalog_id: metadata.catalog_id,
      item_id: metadata.item_id,
      item_revision: metadata.item_revision,
      tags: metadata.tags,
    });
    return result;
  }

  /** Announce the current LISTING_REF to every `announce_to`; never throws. */
  async announce(): Promise<AnnounceResult[]> {
    if (!this.state) return [];
    try {
      return await announceListingRef(this.state.result.listingRef, this.config.announce_to, {
        timeoutMs: this.config.announce_timeout_ms,
        retries: this.config.announce_retries,
        log: this.ctx.logger,
      });
    } catch (err) {
      this.ctx.logger('warn', 'announce errored', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  async start(): Promise<PublisherHandle> {
    // Register our own public key so store.putObject can verify our signature
    // (M3 trust ring resolves signers from saved keys).
    this.ctx.store.saveKey(this.ctx.agentId, this.ctx.secretKey);

    await this.startServer();
    try {
      await this.publish();
      await this.announce();
    } catch (err) {
      await this.closeServer();
      throw err;
    }

    if (this.config.watch) {
      this.startWatch();
    }

    return {
      port: this.boundPort,
      publish: () => this.publish(),
      current: () => this.state?.result ?? null,
      stop: () => this.stop(),
    };
  }

  private startServer(): Promise<void> {
    return new Promise<void>((resolveListen, rejectListen) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
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
        this.ctx.logger('error', 'publisher http server error', { error: String(err) });
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

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, role: 'publisher', agentId: this.ctx.agentId });
      return;
    }

    if (url.pathname === '/listing-ref') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!this.state) {
        sendJson(res, 404, { error: 'no listing published' });
        return;
      }
      sendJson(res, 200, serialize(this.state.result.listingRef));
      return;
    }

    if (url.pathname === '/announce/listing-ref') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!this.state) {
        sendJson(res, 404, { error: 'no listing published' });
        return;
      }
      // The publisher also answers the announce path: it returns its own
      // published reference(s) using the contract's { status, object_id }
      // envelope.
      const current = this.state.result;
      sendJson(res, 200, { status: 'published', object_id: current.objectId, listing_ref: current.listingRef });
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

  private startWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      void this.watchTick();
    }, this.config.poll_interval_ms);
  }

  private async watchTick(): Promise<void> {
    if (this.stopping) return;
    try {
      const entries = await readCatalogDir(this.catalogDir);
      const hash = catalogHash(buildCatalogManifest(entries));
      if (this.state && this.state.result.catalogHash === hash) return; // unchanged
      this.ctx.logger('info', 'catalog changed, republishing', { catalog_hash: hash });
      await this.publish();
      await this.announce();
    } catch (err) {
      this.ctx.logger('error', 'watch republish failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.state) {
      try {
        await this.state.seeder.stop();
      } catch (err) {
        this.ctx.logger('warn', 'seeder stop failed', { error: err instanceof Error ? err.message : String(err) });
      }
      this.state = null;
    }
    await this.closeServer();
  }
}
