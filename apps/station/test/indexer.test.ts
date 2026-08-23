/**
 * S2 acceptance — indexer role.
 *
 *   2. tag search: mirror a catalog with `metadata.tags` → ?tag=朝阳 hits,
 *      ?tag=海淀 misses, multi-tag is AND; untagged catalogs stay mirrored but
 *      stay out of the yellow pages.
 *   3. status page GET / returns 200 text/html with 收录回执数 / 目录数 /
 *      本站公钥 / weights_hash.
 *   4. announce contract: tampered envelope → 400 + verify_result; duplicate
 *      content → 200 idempotent; same object_id different content → 409.
 *   5. changing config.indexer.weights_file changes scores after restart.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildManifest, catalogHash } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';
import { loadWeights, weightsHash } from '@agent-trade/demo-indexer';
import { generateIdentity } from '@agent-trade/identity';
import { openStore } from '@agent-trade/local-store';
import { addSignature, buildObject, objectId } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import { loadOrCreateSeed } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { createIndexerRole } from '../src/roles/indexer/index.js';
import type { IndexerRoleHandle } from '../src/roles/indexer/index.js';
import type { StationConfig, StationContext } from '../src/types.js';
import { tmpDir } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const vectors = JSON.parse(
  readFileSync(new URL('../../../protocol/test-vectors/vectors.json', import.meta.url), 'utf8'),
) as {
  identities: Record<string, { public_key: string; seed: string }>;
  cases: { name: string; file: SignedFile }[];
};

const buyerSeed = vectors.identities.agent_buyer!.seed;
const sellerSeed = vectors.identities.agent_seller!.seed;
const validReceipt = vectors.cases.find((c) => c.name === 'trade-receipt-valid')!.file;

const DEFAULT_WEIGHTS = JSON.parse(readFileSync(new URL('../../demo-indexer/weights.json', import.meta.url), 'utf8')) as object;
const ALT_WEIGHTS = JSON.parse(readFileSync(new URL('../../demo-indexer/weights-alt.json', import.meta.url), 'utf8')) as object;

// ---------------------------------------------------------------------------
// resource tracking
// ---------------------------------------------------------------------------

const opened: Array<{ dir: string; ctx: StationContext }> = [];
const handles: IndexerRoleHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.stop();
    } catch {
      /* ignore */
    }
  }
  for (const { ctx, dir } of opened.splice(0)) {
    try {
      ctx.store.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function buildCtx(): Promise<{ dir: string; ctx: StationContext }> {
  const dir = tmpDir('station-idx-');
  const config: StationConfig = {
    agent_id: 'indexer-agent',
    identity_seed_file: join(dir, 'seed.key'),
    data_dir: join(dir, 'data'),
    http: { host: '127.0.0.1', port: 0 },
    log: { level: 'info' },
    role: 'indexer',
    indexer: {},
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
  opened.push({ dir, ctx });
  return { dir, ctx };
}

/** Write the weights JSON into the ctx dir and point the role config at it. */
function attachWeights(dir: string, ctx: StationContext, weights: object): string {
  const path = join(dir, 'weights.json');
  writeFileSync(path, JSON.stringify(weights, null, 2) + '\n');
  (ctx.config.indexer as Record<string, unknown>)['weights_file'] = path;
  return path;
}

async function startIndexer(ctx: StationContext): Promise<IndexerRoleHandle> {
  const handle = await createIndexerRole().start(ctx);
  handles.push(handle);
  return handle;
}

function makeListingRef(params: {
  publisher: string;
  secretKey: string;
  catalogId: string;
  catalogHash: string;
  itemId: string;
  issuedAt?: string;
}): SignedFile {
  const body = {
    publisher: params.publisher,
    catalog_id: params.catalogId,
    catalog_hash: params.catalogHash,
    item_id: params.itemId,
    item_revision: 0,
  };
  return addSignature(buildObject('LISTING_REF', body), params.publisher, params.secretKey, params.issuedAt);
}

interface CatalogArchiveFixture {
  hash: string;
  rawBody: string;
  manifest: Manifest;
}

/** Build an archive whose self-description sits at `<basename>/catalog.json`
 *  (the publisher/S3 convention). Omit tags to produce an untagged catalog. */
function makeCatalogArchive(tags: string[] | null): CatalogArchiveFixture {
  const basename = 'catalog-a';
  const entries: { path: string; data: Uint8Array }[] = [];
  if (tags !== null) {
    const catalogJson = JSON.stringify({
      catalog_id: 'catalog-a',
      item_id: 'item-a',
      item_revision: 0,
      metadata: { tags },
    });
    entries.push({ path: `${basename}/catalog.json`, data: new TextEncoder().encode(catalogJson) });
  }
  entries.push({ path: `${basename}/item.json`, data: new TextEncoder().encode('{"title":"bolt"}') });

  const manifest = buildManifest(entries);
  const hash = catalogHash(manifest);
  const rawBody = JSON.stringify({
    manifest,
    files: entries.map((e) => ({ path: e.path, content: Buffer.from(e.data).toString('base64') })),
  });
  return { hash, rawBody, manifest };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('indexer role (S2)', () => {
  it('acceptance 2: tag search hits/misses and multi-tag is AND', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_seller', sellerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const archive = makeCatalogArchive(['朝阳', '家电维修']);

    // mirror the catalog, then announce the matching LISTING_REF
    const put = await fetch(`${base}/catalogs/${archive.hash}`, { method: 'PUT', body: archive.rawBody });
    expect(put.status).toBe(201);

    const ref = makeListingRef({
      publisher: 'agent_seller',
      secretKey: sellerSeed,
      catalogId: 'catalog-a',
      catalogHash: archive.hash,
      itemId: 'item-a',
    });
    const announce = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ref),
    });
    expect(announce.status).toBe(200);

    const hit = await fetch(`${base}/catalogs?tag=${encodeURIComponent('朝阳')}`);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as { catalogs: { catalog_hash: string; tags: string[] }[] };
    expect(hitBody.catalogs).toHaveLength(1);
    expect(hitBody.catalogs[0]!.catalog_hash).toBe(archive.hash);
    expect(hitBody.catalogs[0]!.tags).toEqual(['朝阳', '家电维修']);

    const miss = await fetch(`${base}/catalogs?tag=${encodeURIComponent('海淀')}`);
    expect(((await miss.json()) as { catalogs: unknown[] }).catalogs).toHaveLength(0);

    const both = await fetch(`${base}/catalogs?tag=${encodeURIComponent('朝阳')}&tag=${encodeURIComponent('家电维修')}`);
    expect(((await both.json()) as { catalogs: unknown[] }).catalogs).toHaveLength(1);

    const mixed = await fetch(`${base}/catalogs?tag=${encodeURIComponent('朝阳')}&tag=${encodeURIComponent('海淀')}`);
    expect(((await mixed.json()) as { catalogs: unknown[] }).catalogs).toHaveLength(0);
  });

  it('acceptance 2b: untagged catalogs stay in the mirror but out of the yellow pages', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const archive = makeCatalogArchive(null); // no catalog.json → no tags
    const put = await fetch(`${base}/catalogs/${archive.hash}`, { method: 'PUT', body: archive.rawBody });
    expect(put.status).toBe(201);

    // still mirrored byte-identically
    const get = await fetch(`${base}/catalogs/${archive.hash}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(archive.rawBody);

    // but absent from every tag query
    const search = await fetch(`${base}/catalogs?tag=anything`);
    expect(((await search.json()) as { catalogs: unknown[] }).catalogs).toHaveLength(0);
  });

  it('acceptance 3: status page returns 200 text/html with the four required fields', async () => {
    const { dir, ctx } = await buildCtx();
    const weightsFile = attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_buyer', buyerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const archive = makeCatalogArchive(['朝阳']);
    await fetch(`${base}/catalogs/${archive.hash}`, { method: 'PUT', body: archive.rawBody });
    await fetch(`${base}/receipts`, { method: 'POST', body: JSON.stringify(validReceipt) });

    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();

    expect(html).toContain('收录回执数');
    expect(html).toContain('目录数');
    expect(html).toContain(ctx.publicKey);
    expect(html).toContain(weightsHash(loadWeights(weightsFile)));
    expect(html).toContain('id="receipt-count">1<');
    expect(html).toContain('id="catalog-count">1<');
  });

  it('acceptance 4a: tampered envelope → 400 + verify_result', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_seller', sellerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const ref = makeListingRef({
      publisher: 'agent_seller',
      secretKey: sellerSeed,
      catalogId: 'catalog-a',
      catalogHash: `sha256:${'a'.repeat(64)}`,
      itemId: 'item-a',
    });
    const tampered = structuredClone(ref) as SignedFile;
    (tampered.body as { item_id: string }).item_id = 'tampered'; // body changed, body_hash kept

    const res = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; verify_result: string };
    expect(body.verify_result).toBe('fail:body_hash_mismatch');
  });

  it('acceptance 4b: duplicate content is idempotent (200); same object_id different content → 409', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_seller', sellerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const body = {
      publisher: 'agent_seller',
      catalog_id: 'catalog-a',
      catalog_hash: `sha256:${'a'.repeat(64)}`,
      item_id: 'item-a',
      item_revision: 0,
    };
    const first = addSignature(buildObject('LISTING_REF', body), 'agent_seller', sellerSeed, '2026-08-22T02:00:00Z');
    const res1 = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { status: string }).status).toBe('accepted');

    // identical envelope → idempotent 200
    const dup = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    expect(dup.status).toBe(200);

    // same body re-signed with a different issued_at → same object_id, different content → 409
    const conflicting = addSignature(buildObject('LISTING_REF', body), 'agent_seller', sellerSeed, '2026-08-22T03:00:00Z');
    expect(objectId(conflicting)).toBe(objectId(first));
    const conflict = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(conflicting),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe('conflict');
  });

  it('acceptance 5: changing the weights file changes scores after restart', async () => {
    const { dir, ctx } = await buildCtx();
    const weightsFile = attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_buyer', buyerSeed);

    const first = await startIndexer(ctx);
    const post = await fetch(`http://127.0.0.1:${first.port}/receipts`, { method: 'POST', body: JSON.stringify(validReceipt) });
    expect(post.status).toBe(201);
    const view1 = await fetch(`http://127.0.0.1:${first.port}/subjects/agent_seller`);
    expect(((await view1.json()) as { score: number }).score).toBe(30);
    await first.stop();

    // swap the weights file, restart on the same data_dir
    writeFileSync(weightsFile, JSON.stringify(ALT_WEIGHTS, null, 2) + '\n');
    const second = await startIndexer(ctx);
    const view2 = await fetch(`http://127.0.0.1:${second.port}/subjects/agent_seller`);
    expect(((await view2.json()) as { score: number }).score).toBe(25);
  });

  it('acceptance 6a: a key written into the trust ring while running is honoured without restart (200)', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_seller', sellerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    // A new identity arrives while the indexer is already running: drop its seed
    // into the trust ring exactly as another station would, with no restart.
    const newcomer = generateIdentity();
    writeFileSync(
      join(ctx.dataDir, '.data', 'keys', `${encodeURIComponent('agent_new')}.key`),
      `${newcomer.secretKey}\n`,
    );

    const ref = makeListingRef({
      publisher: 'agent_new',
      secretKey: newcomer.secretKey,
      catalogId: 'catalog-new',
      catalogHash: `sha256:${'b'.repeat(64)}`,
      itemId: 'item-new',
    });
    const res = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ref),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('accepted');
  });

  it('acceptance 6b: a tampered envelope returns 400 + verify_result (not 500)', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    ctx.store.saveKey('agent_seller', sellerSeed);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const ref = makeListingRef({
      publisher: 'agent_seller',
      secretKey: sellerSeed,
      catalogId: 'catalog-a',
      catalogHash: `sha256:${'a'.repeat(64)}`,
      itemId: 'item-a',
    });
    const tampered = structuredClone(ref) as SignedFile;
    // Replace with a schema-valid (86-char base64url) but cryptographically
    // wrong signature, so it reaches the signature step rather than the schema.
    tampered.signatures = [{ ...tampered.signatures[0]!, signature: 'A'.repeat(86) }];

    const res = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; verify_result: string };
    expect(body.verify_result).toBe('fail:signature_invalid');
  });

  it('acceptance 7: a compact announcement bootstraps a public key and is searchable without a full mirror', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const newcomer = generateIdentity();
    const archive = makeCatalogArchive(['浦东', '紧固件']);
    const archiveBody = JSON.parse(archive.rawBody) as {
      manifest: Manifest;
      files: { path: string; content: string }[];
    };
    const catalogJson = archiveBody.files.find((file) => file.path.endsWith('/catalog.json'))!;
    const ref = makeListingRef({
      publisher: 'agent_new',
      secretKey: newcomer.secretKey,
      catalogId: 'catalog-new',
      catalogHash: archive.hash,
      itemId: 'item-new',
    });
    const announcement = {
      identity: { agent_id: 'agent_new', public_key: newcomer.publicKey },
      listing_ref: ref,
      catalog: { manifest: archiveBody.manifest, catalog_json: catalogJson },
    };

    const accepted = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(announcement),
    });
    expect(accepted.status).toBe(200);
    expect(ctx.store.getKey('agent_new')).toBeUndefined();
    expect(ctx.store.getPublicKey('agent_new')).toBe(newcomer.publicKey);

    const search = await fetch(`${base}/catalogs?tag=${encodeURIComponent('紧固件')}`);
    const searchBody = (await search.json()) as { catalogs: { catalog_hash: string }[] };
    expect(searchBody.catalogs.map((entry) => entry.catalog_hash)).toContain(archive.hash);

    const card = await fetch(`${base}/catalogs/${encodeURIComponent(archive.hash)}/card`);
    expect(card.status).toBe(200);
    const fullArchive = await fetch(`${base}/catalogs/${encodeURIComponent(archive.hash)}`);
    expect(fullArchive.status).toBe(404);
  });

  it('acceptance 7b: a tampered catalog card is rejected before its public key is trusted', async () => {
    const { dir, ctx } = await buildCtx();
    attachWeights(dir, ctx, DEFAULT_WEIGHTS);
    const handle = await startIndexer(ctx);
    const base = `http://127.0.0.1:${handle.port}`;

    const newcomer = generateIdentity();
    const archive = makeCatalogArchive(['测试']);
    const archiveBody = JSON.parse(archive.rawBody) as {
      manifest: Manifest;
      files: { path: string; content: string }[];
    };
    const catalogJson = archiveBody.files.find((file) => file.path.endsWith('/catalog.json'))!;
    catalogJson.content = Buffer.from('{"metadata":{"tags":["篡改"]}}').toString('base64');
    const ref = makeListingRef({
      publisher: 'agent_tampered',
      secretKey: newcomer.secretKey,
      catalogId: 'catalog-tampered',
      catalogHash: archive.hash,
      itemId: 'item-tampered',
    });

    const res = await fetch(`${base}/announce/listing-ref`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity: { agent_id: 'agent_tampered', public_key: newcomer.publicKey },
        listing_ref: ref,
        catalog: { manifest: archiveBody.manifest, catalog_json: catalogJson },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_catalog_card');
    expect(ctx.store.getPublicKey('agent_tampered')).toBeUndefined();
  });
});
