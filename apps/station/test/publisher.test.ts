/**
 * S3 acceptance — publisher role.
 *
 *   1. minimal catalog → LISTING_REF `verifyFile === 'valid'`, `catalog_hash`
 *      consistent with the manifest (and tags stay out of the body).
 *   2. local-tracker seed→download round-trip; after the publisher stops, an
 *      HTTP mirror still serves the catalog archive.
 *   3. content change → new catalog_hash / object_id; the old signed file is
 *      preserved (not overwritten).
 *   4. announce to a test indexer (queryable); an unreachable indexer only
 *      logs retry failures and never blocks seeding.
 *   5. GET /healthz, /listing-ref, /catalogs/:hash (plus POST announce + 404).
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { catalogHash, download, startTracker, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import type { Manifest, TrackerHandle } from '@agent-trade/bt-catalog';
import { openStore } from '@agent-trade/local-store';
import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import { loadOrCreateSeed } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { createPublisherRole } from '../src/roles/publisher/index.js';
import type { PublisherHandle } from '../src/roles/publisher/index.js';
import type { StationConfig, StationContext } from '../src/types.js';
import { freePort, tmpDir } from './helpers.js';

// ---------------------------------------------------------------------------
// resource tracking (clean shutdown so webtorrent never keeps vitest alive)
// ---------------------------------------------------------------------------

interface OpenedCtx {
  dir: string;
  ctx: StationContext;
}

const contexts: OpenedCtx[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
const trackers: TrackerHandle[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.stop();
    } catch {
      /* ignore */
    }
  }
  for (const tracker of trackers.splice(0)) {
    try {
      await tracker.close();
    } catch {
      /* ignore */
    }
  }
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
  for (const { ctx, dir } of contexts.splice(0)) {
    try {
      ctx.store.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface CatalogFixture {
  catalogId: string;
  itemId: string;
  revision: number;
  tags: string[];
}

function writeCatalog(dir: string, fixture: CatalogFixture, extraFiles?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const catalogJson = {
    catalog_id: fixture.catalogId,
    item_id: fixture.itemId,
    item_revision: fixture.revision,
    metadata: { tags: fixture.tags },
  };
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalogJson, null, 2) + '\n');
  writeFileSync(
    join(dir, 'item.json'),
    JSON.stringify({ title: 'M8 stainless bolt', description: '304, 40mm, 100/pkg', price: '12.00' }, null, 2) + '\n',
  );
  for (const [name, content] of Object.entries(extraFiles ?? {})) {
    writeFileSync(join(dir, name), content);
  }
}

async function buildCtx(publisher: Record<string, unknown>): Promise<{ dir: string; ctx: StationContext }> {
  const dir = tmpDir('station-pub-');
  const port = await freePort();
  const config: StationConfig = {
    agent_id: 'publisher-agent',
    identity_seed_file: join(dir, 'seed.key'),
    data_dir: join(dir, 'data'),
    http: { host: '127.0.0.1', port },
    log: { level: 'info' },
    role: 'publisher',
    publisher,
  };
  const identity = loadOrCreateSeed(config.identity_seed_file);
  const store = openStore(config.data_dir);
  const logger = createLogger(config.log);
  const ctx: StationContext = {
    agentId: config.agent_id,
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
    config,
    dataDir: config.data_dir,
    store,
    logger,
  };
  contexts.push({ dir, ctx });
  return { dir, ctx };
}

async function startPublisher(
  ctx: StationContext,
): Promise<PublisherHandle> {
  const handle = await createPublisherRole().start(ctx);
  handles.push(handle);
  return handle;
}

function resolveKeyFor(ctx: StationContext): (signer: string) => string | undefined {
  return (signer) => (signer === ctx.agentId ? ctx.publicKey : undefined);
}

async function httpGet(url: string): Promise<Response> {
  const res = await fetch(url);
  return res;
}

/** A minimal announce target that verifies + stores LISTING_REFs and serves them. */
async function startIndexerStub(
  agentId: string,
  publicKey: string,
): Promise<{ port: number; refs: Map<string, SignedFile> }> {
  const refs = new Map<string, SignedFile>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/refs') {
      json(200, [...refs.values()]);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/announce/listing-ref') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        let file: unknown;
        try {
          file = JSON.parse(raw);
        } catch {
          json(400, { error: 'invalid_json' });
          return;
        }
        const announcement = file as { listing_ref?: SignedFile };
        const listingRef = announcement.listing_ref ?? (file as SignedFile);
        const result = verifyFile(listingRef, (signer) => (signer === agentId ? publicKey : undefined));
        if (result !== 'valid') {
          json(400, { error: 'verify_failed', verify_result: result });
          return;
        }
        const id = objectId(listingRef);
        refs.set(id, listingRef);
        json(200, { status: 'accepted', object_id: id });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  servers.push({ close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) });
  return { port, refs };
}

/** A minimal catalog mirror: store an archive body, serve it back by hash. */
async function startMirrorStub(): Promise<{
  port: number;
  store(hash: string, body: string): void;
}> {
  const catalogs = new Map<string, string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/catalogs\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const body = catalogs.get(decodeURIComponent(match[1]!));
      if (body === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'catalog_not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  servers.push({ close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())) });
  return { port, store: (hash, body) => catalogs.set(hash, body) };
}

function decodeArchive(body: { manifest: Manifest; files: { path: string; content: string }[] }): {
  path: string;
  data: Uint8Array;
}[] {
  return body.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('publisher role (S3)', () => {
  it('acceptance 1: publishes a valid LISTING_REF whose catalog_hash matches the manifest', async () => {
    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'pudong-fasteners', itemId: 'bolt-m8', revision: 3, tags: ['螺栓', '五金'] });

    const { ctx } = await buildCtx({
      catalog_dir: catalogDir,
      trackers: [],
      announce_to: [],
      dht: false,
      public_base_url: 'https://catalog.example/station/',
    });
    const handle = await startPublisher(ctx);

    const listing = handle.current()!;
    expect(listing).not.toBeNull();

    // LISTING_REF verifies as 'valid' with the publisher's public key.
    expect(verifyFile(listing.listingRef, resolveKeyFor(ctx))).toBe('valid');
    expect(listing.listingRef.object_type).toBe('LISTING_REF');

    const body = listing.listingRef.body as {
      publisher: string;
      catalog_id: string;
      item_id: string;
      item_revision: number;
      catalog_hash: string;
      distribution_refs: { type: string; uri: string }[];
    };
    expect(body.publisher).toBe(ctx.agentId);
    expect(body.catalog_id).toBe('pudong-fasteners');
    expect(body.item_id).toBe('bolt-m8');
    expect(body.item_revision).toBe(3);
    // tags must NOT be in the LISTING_REF body (schema additionalProperties:false)
    expect(body).not.toHaveProperty('tags');

    // distribution_refs carries the magnet + the local HTTP fallback.
    const magnet = body.distribution_refs.find((d) => d.type === 'magnet');
    const https = body.distribution_refs.find((d) => d.type === 'https');
    expect(magnet).toBeDefined();
    expect(https).toBeDefined();
    expect(https!.uri).toBe(`https://catalog.example/station/catalogs/${body.catalog_hash}`);

    // catalog_hash equals catalogHash over the served archive manifest, and the
    // archive files verify against that manifest.
    const archiveRes = await httpGet(`http://127.0.0.1:${handle.port}/catalogs/${body.catalog_hash}`);
    expect(archiveRes.status).toBe(200);
    const archive = (await archiveRes.json()) as { manifest: Manifest; files: { path: string; content: string }[] };
    expect(catalogHash(archive.manifest)).toBe(body.catalog_hash);
    expect(verifyCatalogFiles(decodeArchive(archive), archive.manifest)).toBe(true);

    // tags live in the (hash-protected) catalog.json content, not in the ref.
    const catalogJsonEntry = archive.files.find((f) => f.path.endsWith('/catalog.json'));
    expect(catalogJsonEntry).toBeDefined();
    const catalogJson = JSON.parse(Buffer.from(catalogJsonEntry!.content, 'base64').toString('utf8')) as {
      metadata: { tags: string[] };
    };
    expect(catalogJson.metadata.tags).toEqual(['螺栓', '五金']);
  });

  it('acceptance 2: seed→download round-trip, and the mirror serves after the publisher stops', async () => {
    const tracker = await startTracker(0);
    trackers.push(tracker);
    const announceUrl = `http://127.0.0.1:${tracker.port}/announce`;

    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'catalog-a', itemId: 'item-a', revision: 0, tags: ['玩偶'] });

    const { ctx } = await buildCtx({
      catalog_dir: catalogDir,
      trackers: [announceUrl],
      announce_to: [],
      dht: false,
    });
    const handle = await startPublisher(ctx);
    const listing = handle.current()!;

    // round-trip: download the magnet and rebuild the manifest.
    const destDir = tmpDir('station-dl-');
    dirs.push(destDir);
    const manifest = await download(listing.magnetURI, destDir, { tracker: [announceUrl], dht: false });
    expect(catalogHash(manifest)).toBe(listing.catalogHash);

    // mirror: fetch the archive over HTTP, then stop the publisher.
    const mirror = await startMirrorStub();
    const rawBody = await (await httpGet(`http://127.0.0.1:${handle.port}/catalogs/${listing.catalogHash}`)).text();
    mirror.store(listing.catalogHash, rawBody);

    await handle.stop();

    // the mirror still serves the archive byte-identically after the kill.
    const mirrored = await httpGet(`http://127.0.0.1:${mirror.port}/catalogs/${listing.catalogHash}`);
    expect(mirrored.status).toBe(200);
    expect(await mirrored.text()).toBe(rawBody);

    const served = JSON.parse(rawBody) as { manifest: Manifest; files: { path: string; content: string }[] };
    expect(catalogHash(served.manifest)).toBe(listing.catalogHash);
    expect(verifyCatalogFiles(decodeArchive(served), served.manifest)).toBe(true);
  });

  it('acceptance 3: content change yields new hash/object_id and preserves the old signed file', async () => {
    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'catalog-b', itemId: 'item-b', revision: 0, tags: ['标签A'] });

    const { ctx } = await buildCtx({ catalog_dir: catalogDir, trackers: [], announce_to: [], dht: false });
    const handle = await startPublisher(ctx);

    const before = handle.current()!;
    const oldHash = before.catalogHash;
    const oldObjectId = before.objectId;
    expect(ctx.store.getObject(oldObjectId)).toBeDefined();

    // change the catalog content (revision bump + tags) then re-publish.
    writeCatalog(catalogDir, { catalogId: 'catalog-b', itemId: 'item-b', revision: 1, tags: ['标签B'] });
    const after = await handle.publish();

    expect(after.catalogHash).not.toBe(oldHash);
    expect(after.objectId).not.toBe(oldObjectId);

    // old signed file is still readable and unchanged; new one is present too.
    const oldFile = ctx.store.getObject(oldObjectId);
    expect(oldFile).toBeDefined();
    expect((oldFile!.body as { catalog_hash: string }).catalog_hash).toBe(oldHash);
    expect(ctx.store.getObject(after.objectId)).toBeDefined();

    // GET /listing-ref now serves the *new* ref.
    const res = await httpGet(`http://127.0.0.1:${handle.port}/listing-ref`);
    const served = (await res.json()) as SignedFile;
    expect((served.body as { catalog_hash: string }).catalog_hash).toBe(after.catalogHash);
  });

  it('acceptance 4a: announces to a test indexer which indexes and exposes the ref', async () => {
    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'catalog-c', itemId: 'item-c', revision: 0, tags: ['朝阳', '家电维修'] });

    const { ctx } = await buildCtx({ catalog_dir: catalogDir, trackers: [], announce_to: [], dht: false });
    const indexer = await startIndexerStub(ctx.agentId, ctx.publicKey);

    // point announce_to at the stub, then start.
    (ctx.config.publisher as Record<string, unknown>)['announce_to'] = [`http://127.0.0.1:${indexer.port}`];
    const handle = await startPublisher(ctx);
    const listing = handle.current()!;

    // after start() the announce has completed: the stub already holds the ref.
    expect(indexer.refs.size).toBe(1);
    expect(indexer.refs.has(listing.objectId)).toBe(true);

    const refsRes = await httpGet(`http://127.0.0.1:${indexer.port}/refs`);
    const refs = (await refsRes.json()) as SignedFile[];
    expect(refs).toHaveLength(1);
    expect(verifyFile(refs[0]!, (signer) => (signer === ctx.agentId ? ctx.publicKey : undefined))).toBe('valid');
  });

  it('acceptance 4b: an unreachable indexer only logs retry failures and never blocks seeding', async () => {
    const tracker = await startTracker(0);
    trackers.push(tracker);
    const announceUrl = `http://127.0.0.1:${tracker.port}/announce`;
    const deadPort = await freePort(); // nothing listens here → connection refused

    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'catalog-d', itemId: 'item-d', revision: 0, tags: ['玩具'] });

    const { ctx } = await buildCtx({
      catalog_dir: catalogDir,
      trackers: [announceUrl],
      announce_to: [`http://127.0.0.1:${deadPort}`],
      dht: false,
      announce_timeout_ms: 500,
      announce_retries: 1,
    });
    // must resolve (not throw) even though the indexer is down
    const handle = await startPublisher(ctx);

    // seeding is active: healthz is up and the magnet still round-trips.
    const health = await httpGet(`http://127.0.0.1:${handle.port}/healthz`);
    expect(health.status).toBe(200);

    const destDir = tmpDir('station-dl-');
    dirs.push(destDir);
    const manifest = await download(handle.current()!.magnetURI, destDir, { tracker: [announceUrl], dht: false });
    expect(catalogHash(manifest)).toBe(handle.current()!.catalogHash);
  });

  it('acceptance 5: serves /healthz, /listing-ref, /catalogs/:hash and POST announce', async () => {
    const catalogDir = tmpDir('station-cat-');
    dirs.push(catalogDir);
    writeCatalog(catalogDir, { catalogId: 'catalog-e', itemId: 'item-e', revision: 0, tags: ['测试'] });

    const { ctx } = await buildCtx({ catalog_dir: catalogDir, trackers: [], announce_to: [], dht: false });
    const handle = await startPublisher(ctx);
    const listing = handle.current()!;
    const base = `http://127.0.0.1:${handle.port}`;

    const health = await httpGet(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, role: 'publisher', agentId: ctx.agentId });

    const ref = await httpGet(`${base}/listing-ref`);
    expect(ref.status).toBe(200);
    const refBody = (await ref.json()) as SignedFile;
    expect(refBody.object_type).toBe('LISTING_REF');
    expect(objectId(refBody)).toBe(listing.objectId);

    const archive = await httpGet(`${base}/catalogs/${listing.catalogHash}`);
    expect(archive.status).toBe(200);
    expect(((await archive.json()) as { manifest: unknown }).manifest).toBeDefined();

    const postAnnounce = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(postAnnounce.status).toBe(200);
    const announceBody = (await postAnnounce.json()) as { status: string; object_id: string; listing_ref: SignedFile };
    expect(announceBody.status).toBe('published');
    expect(announceBody.object_id).toBe(listing.objectId);
    expect(announceBody.listing_ref.object_type).toBe('LISTING_REF');

    const reannounce = await fetch(`${base}/announce`, { method: 'POST' });
    expect(reannounce.status).toBe(200);
    expect(((await reannounce.json()) as { status: string }).status).toBe('announced');

    const missing = await httpGet(`${base}/catalogs/sha256:${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);

    const unknown = await httpGet(`${base}/nope`);
    expect(unknown.status).toBe(404);
  });
});
