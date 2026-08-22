/**
 * S4 acceptance — integrator role.
 *
 *   1. member verification: a tampered LISTING_REF and an unknown-signer
 *      LISTING_REF are excluded and logged; a valid member is included.
 *   2. topic catalog manifest is canonical (paths/sort/lowercase-hex sha256),
 *      the signed LISTING_REF verifies 'valid', and tags are correct.
 *   3. reseed:true downloads a member catalog and re-serves / re-seeds it
 *      (mirror semantics: HTTP archive + downloadable re-seed magnet).
 *   4. announce to an indexer makes the topic catalog searchable by tag; a
 *      member update then `POST /refresh` yields a new object_id (old preserved).
 *   5. HTTP surface: /healthz, /catalog, /listing-ref, /refresh, /catalogs/:hash.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { catalogHash, download, startTracker, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import type { Manifest, TrackerHandle } from '@agent-trade/bt-catalog';
import { openStore } from '@agent-trade/local-store';
import { addSignature, buildObject, serialize, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import { loadOrCreateSeed } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { createIndexerRole } from '../src/roles/indexer/index.js';
import type { IndexerRoleHandle } from '../src/roles/indexer/index.js';
import { createIntegratorRole } from '../src/roles/integrator/index.js';
import type { IntegratorHandle } from '../src/roles/integrator/index.js';
import { createPublisherRole } from '../src/roles/publisher/index.js';
import type { PublisherHandle } from '../src/roles/publisher/index.js';
import type { StationConfig, StationContext } from '../src/types.js';
import { tmpDir } from './helpers.js';

// ---------------------------------------------------------------------------
// resource tracking (clean shutdown so webtorrent never keeps vitest alive)
// ---------------------------------------------------------------------------

interface LogRecord {
  level: string;
  msg: string;
  extra?: object;
}

interface OpenedCtx {
  dir: string;
  ctx: StationContext;
  logs: LogRecord[];
}

const opened: OpenedCtx[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
const trackers: TrackerHandle[] = [];
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
  for (const { ctx, dir } of opened.splice(0)) {
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

const DUMMY_HASH_A = `sha256:${'a'.repeat(64)}`;
const DUMMY_HASH_B = `sha256:${'b'.repeat(64)}`;

function makeMemberRef(params: {
  publisher: string;
  secretKey: string;
  catalogId: string;
  itemId: string;
  catalogHash: string;
  revision?: number;
  magnetURI?: string;
}): SignedFile {
  const body: Record<string, unknown> = {
    publisher: params.publisher,
    catalog_id: params.catalogId,
    item_id: params.itemId,
    item_revision: params.revision ?? 0,
    catalog_hash: params.catalogHash,
  };
  if (params.magnetURI !== undefined) {
    body['distribution_refs'] = [{ type: 'magnet', uri: params.magnetURI }];
  }
  return addSignature(buildObject('LISTING_REF', body), params.publisher, params.secretKey);
}

function writeMemberFile(dir: string, name: string, ref: SignedFile): string {
  const path = join(dir, name);
  writeFileSync(path, serialize(ref));
  return path;
}

function decodeArchive(body: { manifest: Manifest; files: { path: string; content: string }[] }): {
  path: string;
  data: Uint8Array;
}[] {
  return body.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
}

async function buildIntegratorCtx(
  integrator: Record<string, unknown>,
  agentId = 'integrator-agent',
): Promise<OpenedCtx> {
  const dir = tmpDir('station-int-');
  const config: StationConfig = {
    agent_id: agentId,
    identity_seed_file: join(dir, 'seed.key'),
    data_dir: join(dir, 'data'),
    http: { host: '127.0.0.1', port: 0 },
    log: { level: 'info' },
    role: 'integrator',
    integrator,
  };
  const identity = loadOrCreateSeed(config.identity_seed_file);
  const store = openStore(config.data_dir);
  const logs: LogRecord[] = [];
  const logger: StationContext['logger'] = (level, msg, extra) => {
    logs.push({ level, msg, extra });
  };
  const ctx: StationContext = {
    agentId: config.agent_id,
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
    config,
    dataDir: config.data_dir,
    store,
    logger,
  };
  opened.push({ dir, ctx, logs });
  return { dir, ctx, logs };
}

async function startIntegrator(ctx: StationContext): Promise<IntegratorHandle> {
  const handle = await createIntegratorRole().start(ctx);
  handles.push(handle);
  return handle;
}

function resolveOwnKey(ctx: StationContext): (signer: string) => string | undefined {
  return (signer) => (signer === ctx.agentId ? ctx.publicKey : undefined);
}

const DEFAULT_WEIGHTS = JSON.parse(
  readFileSync(new URL('../../demo-indexer/weights.json', import.meta.url), 'utf8'),
) as object;

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('integrator role (S4)', () => {
  it('acceptance 1: tampered and unknown-signer members are excluded and logged; valid member included', async () => {
    const membersDir = tmpDir('station-int-members-');
    dirs.push(membersDir);
    const memberA = loadOrCreateSeed(join(membersDir, 'member-a.seed'));
    const memberUnknown = loadOrCreateSeed(join(membersDir, 'member-unknown.seed'));

    const valid = makeMemberRef({
      publisher: 'member-a',
      secretKey: memberA.secretKey,
      catalogId: 'cat-a',
      itemId: 'item-a',
      catalogHash: DUMMY_HASH_A,
    });
    const tampered = structuredClone(valid) as SignedFile;
    (tampered.body as { catalog_id: string }).catalog_id = 'tampered'; // body changed, body_hash kept
    const unknown = makeMemberRef({
      publisher: 'member-unknown',
      secretKey: memberUnknown.secretKey,
      catalogId: 'cat-u',
      itemId: 'item-u',
      catalogHash: DUMMY_HASH_B,
    });

    const validPath = writeMemberFile(membersDir, 'valid.json', valid);
    const tamperedPath = writeMemberFile(membersDir, 'tampered.json', tampered);
    const unknownPath = writeMemberFile(membersDir, 'unknown.json', unknown);

    const { ctx, logs } = await buildIntegratorCtx({
      theme: '五金',
      tags: ['螺栓'],
      members: [validPath, tamperedPath, unknownPath],
      reseed: false,
      announce_to: [],
    });
    ctx.store.saveKey('member-a', memberA.secretKey);

    const handle = await startIntegrator(ctx);
    const current = handle.current()!;

    expect(current.members).toHaveLength(1);
    expect(current.members[0]!.publisher).toBe('member-a');

    expect(current.rejected).toHaveLength(2);
    const reasons = current.rejected.map((r) => r.reason).join(' | ');
    expect(reasons).toContain('fail:body_hash_mismatch');
    expect(reasons).toContain('fail:unknown_signer');

    // the exclusions are logged (warn level)
    const rejectedLogs = logs.filter((l) => l.level === 'warn' && l.msg === 'member rejected');
    expect(rejectedLogs.length).toBe(2);
    expect(rejectedLogs.map((l) => l.extra as { reason: string }).map((e) => e.reason).join(' | ')).toContain(
      'fail:body_hash_mismatch',
    );
  });

  it('acceptance 2: canonical topic catalog manifest, valid LISTING_REF, correct tags', async () => {
    const membersDir = tmpDir('station-int-members-');
    dirs.push(membersDir);
    const memberA = loadOrCreateSeed(join(membersDir, 'member-a.seed'));
    const memberB = loadOrCreateSeed(join(membersDir, 'member-b.seed'));

    const refA = makeMemberRef({
      publisher: 'member-a',
      secretKey: memberA.secretKey,
      catalogId: 'cat-a',
      itemId: 'item-a',
      catalogHash: DUMMY_HASH_A,
    });
    const refB = makeMemberRef({
      publisher: 'member-b',
      secretKey: memberB.secretKey,
      catalogId: 'cat-b',
      itemId: 'item-b',
      catalogHash: DUMMY_HASH_B,
      revision: 2,
    });

    const { ctx } = await buildIntegratorCtx({
      theme: '五金',
      tags: ['螺栓', '紧固件'],
      members: [
        writeMemberFile(membersDir, 'a.json', refA),
        writeMemberFile(membersDir, 'b.json', refB),
      ],
      reseed: false,
      announce_to: [],
    });
    ctx.store.saveKey('member-a', memberA.secretKey);
    ctx.store.saveKey('member-b', memberB.secretKey);

    const handle = await startIntegrator(ctx);
    const current = handle.current()!;

    // signed LISTING_REF verifies 'valid' with the integrator's own key.
    expect(verifyFile(current.listingRef, resolveOwnKey(ctx))).toBe('valid');
    const body = current.listingRef.body as {
      publisher: string;
      catalog_id: string;
      catalog_hash: string;
      distribution_refs: { type: string; uri: string }[];
    };
    expect(body.publisher).toBe(ctx.agentId);
    // tags must NOT be in the LISTING_REF body (schema additionalProperties:false)
    expect(body).not.toHaveProperty('tags');
    expect(body.distribution_refs.some((d) => d.type === 'https' && d.uri.endsWith('/catalog'))).toBe(true);

    // topic catalog served over HTTP is a canonical M8 archive.
    const res = await fetch(`http://127.0.0.1:${handle.port}/catalog`);
    expect(res.status).toBe(200);
    const archive = (await res.json()) as { manifest: Manifest; files: { path: string; content: string }[] };

    // canonical manifest: lowercase-hex sha256 + byte-order sorted paths.
    for (const entry of archive.manifest.files) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (let i = 1; i < archive.manifest.files.length; i++) {
      const prev = archive.manifest.files[i - 1]!.path;
      const cur = archive.manifest.files[i]!.path;
      expect(Buffer.compare(Buffer.from(prev, 'utf8'), Buffer.from(cur, 'utf8'))).toBeLessThan(0);
    }
    expect(catalogHash(archive.manifest)).toBe(body.catalog_hash);
    expect(catalogHash(archive.manifest)).toBe(current.catalogHash);
    expect(verifyCatalogFiles(decodeArchive(archive), archive.manifest)).toBe(true);

    // catalog.json carries theme, members summary and metadata.tags.
    const catalogJsonEntry = archive.files.find((f) => f.path === 'catalog.json');
    expect(catalogJsonEntry).toBeDefined();
    const catalogJson = JSON.parse(Buffer.from(catalogJsonEntry!.content, 'base64').toString('utf8')) as {
      theme: string;
      members: { publisher: string; ref_file: string; item_revision?: number }[];
      metadata: { tags: string[] };
    };
    expect(catalogJson.theme).toBe('五金');
    expect(catalogJson.metadata.tags).toEqual(['螺栓', '紧固件']);
    expect(catalogJson.members).toHaveLength(2);
    expect(catalogJson.members.map((m) => m.publisher).sort()).toEqual(['member-a', 'member-b']);
    // each member summary's ref_file is present in the archive.
    for (const m of catalogJson.members) {
      expect(archive.files.some((f) => f.path === m.ref_file)).toBe(true);
    }
  });

  it('acceptance 3: reseed:true mirrors a member catalog (HTTP archive + re-seed download)', async () => {
    const tracker = await startTracker(0);
    trackers.push(tracker);
    const announceUrl = `http://127.0.0.1:${tracker.port}/announce`;

    // A publisher member that seeds a catalog.
    const catalogDir = tmpDir('station-int-cat-');
    dirs.push(catalogDir);
    writeFileSync(
      join(catalogDir, 'catalog.json'),
      JSON.stringify(
        { catalog_id: 'cat-m', item_id: 'item-m', item_revision: 0, metadata: { tags: ['玩偶'] } },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(catalogDir, 'item.json'), JSON.stringify({ title: 'bolt' }) + '\n');

    const pubDir = tmpDir('station-int-pub-');
    const pubConfig: StationConfig = {
      agent_id: 'publisher-agent',
      identity_seed_file: join(pubDir, 'seed.key'),
      data_dir: join(pubDir, 'data'),
      http: { host: '127.0.0.1', port: 0 },
      log: { level: 'info' },
      role: 'publisher',
      publisher: {
        catalog_dir: catalogDir,
        trackers: [announceUrl],
        announce_to: [],
        dht: false,
      },
    };
    const pubIdentity = loadOrCreateSeed(pubConfig.identity_seed_file);
    const pubStore = openStore(pubConfig.data_dir);
    const pubCtx: StationContext = {
      agentId: pubConfig.agent_id,
      publicKey: pubIdentity.publicKey,
      secretKey: pubIdentity.secretKey,
      config: pubConfig,
      dataDir: pubConfig.data_dir,
      store: pubStore,
      logger: createLogger(pubConfig.log),
    };
    opened.push({ dir: pubDir, ctx: pubCtx, logs: [] });
    const pubHandle: PublisherHandle = await createPublisherRole().start(pubCtx);
    handles.push(pubHandle);

    const memberHash = pubHandle.current()!.catalogHash;
    const memberMagnet = pubHandle.current()!.magnetURI;

    // Point the integrator at the publisher's LISTING_REF file.
    const { dir, ctx } = await buildIntegratorCtx({
      theme: '玩具',
      tags: ['玩偶'],
      members: [],
      reseed: true,
      announce_to: [],
      trackers: [announceUrl],
      dht: false,
    });
    (ctx.config.integrator as Record<string, unknown>)['members'] = [join(dir, 'member.json')];
    ctx.store.saveKey(pubCtx.agentId, pubCtx.secretKey);
    writeMemberFile(dir, 'member.json', pubHandle.current()!.listingRef);

    const handle = await startIntegrator(ctx);
    const current = handle.current()!;

    expect(current.reseed).toHaveLength(1);
    expect(current.reseed[0]!.catalog_hash).toBe(memberHash);
    expect(current.reseed[0]!.magnetURI).not.toBeNull();

    // mirror (archive): the member catalog is retrievable byte-identically.
    const served = await fetch(`http://127.0.0.1:${handle.port}/catalogs/${memberHash}`);
    expect(served.status).toBe(200);
    const archive = (await served.json()) as { manifest: Manifest; files: { path: string; content: string }[] };
    expect(catalogHash(archive.manifest)).toBe(memberHash);
    expect(verifyCatalogFiles(decodeArchive(archive), archive.manifest)).toBe(true);

    // relay (re-seed): downloading the integrator's re-seed magnet round-trips.
    const destDir = tmpDir('station-int-dl-');
    dirs.push(destDir);
    const manifest = await download(current.reseed[0]!.magnetURI!, destDir, {
      tracker: [announceUrl],
      dht: false,
    });
    expect(catalogHash(manifest)).toBe(memberHash);
    expect(memberMagnet).toBeTruthy();
  });

  it('acceptance 4: announce to an indexer makes the topic catalog tag-searchable; refresh yields a new object_id', async () => {
    // --- a real indexer to receive the announce ------------------------------
    const idxDir = tmpDir('station-int-idx-');
    dirs.push(idxDir);
    const weightsFile = join(idxDir, 'weights.json');
    writeFileSync(weightsFile, JSON.stringify(DEFAULT_WEIGHTS, null, 2) + '\n');
    const idxConfig: StationConfig = {
      agent_id: 'indexer-agent',
      identity_seed_file: join(idxDir, 'seed.key'),
      data_dir: join(idxDir, 'data'),
      http: { host: '127.0.0.1', port: 0 },
      log: { level: 'info' },
      role: 'indexer',
      indexer: { weights_file: weightsFile },
    };
    const idxIdentity = loadOrCreateSeed(idxConfig.identity_seed_file);
    const idxStore = openStore(idxConfig.data_dir);
    const idxCtx: StationContext = {
      agentId: idxConfig.agent_id,
      publicKey: idxIdentity.publicKey,
      secretKey: idxIdentity.secretKey,
      config: idxConfig,
      dataDir: idxConfig.data_dir,
      store: idxStore,
      logger: createLogger(idxConfig.log),
    };
    opened.push({ dir: idxDir, ctx: idxCtx, logs: [] });
    const idxHandle: IndexerRoleHandle = await createIndexerRole().start(idxCtx);
    handles.push(idxHandle);

    // --- a member whose LISTING_REF will change across refreshes ------------
    const membersDir = tmpDir('station-int-members-');
    dirs.push(membersDir);
    const member = loadOrCreateSeed(join(membersDir, 'member.seed'));

    const { ctx } = await buildIntegratorCtx({
      theme: '五金',
      tags: ['螺栓'],
      members: [join(membersDir, 'member.json')],
      reseed: false,
      announce_to: [`http://127.0.0.1:${idxHandle.port}`],
    });
    // the indexer verifies the integrator's LISTING_REF through the trust ring.
    idxCtx.store.saveKey(ctx.agentId, ctx.secretKey);
    ctx.store.saveKey('member', member.secretKey);

    writeMemberFile(
      membersDir,
      'member.json',
      makeMemberRef({
        publisher: 'member',
        secretKey: member.secretKey,
        catalogId: 'cat-a',
        itemId: 'item-a',
        catalogHash: DUMMY_HASH_A,
      }),
    );

    const handle = await startIntegrator(ctx);
    const before = handle.current()!;

    // mirror the topic catalog into the indexer, then search by tag.
    const catalogRes = await fetch(`http://127.0.0.1:${handle.port}/catalog`);
    const catalogRaw = await catalogRes.text();
    const put = await fetch(`http://127.0.0.1:${idxHandle.port}/catalogs/${before.catalogHash}`, {
      method: 'PUT',
      body: catalogRaw,
    });
    expect(put.status).toBe(201);

    const search = await fetch(`http://127.0.0.1:${idxHandle.port}/catalogs?tag=${encodeURIComponent('螺栓')}`);
    const searchBody = (await search.json()) as {
      catalogs: { catalog_hash: string; tags: string[]; object_id: string; publisher: string }[];
    };
    expect(searchBody.catalogs).toHaveLength(1);
    expect(searchBody.catalogs[0]!.catalog_hash).toBe(before.catalogHash);
    expect(searchBody.catalogs[0]!.tags).toEqual(['螺栓']);
    expect(searchBody.catalogs[0]!.object_id).toBe(before.objectId);
    expect(searchBody.catalogs[0]!.publisher).toBe(ctx.agentId);

    // member content changes → refresh produces a new object_id; old preserved.
    writeMemberFile(
      membersDir,
      'member.json',
      makeMemberRef({
        publisher: 'member',
        secretKey: member.secretKey,
        catalogId: 'cat-a',
        itemId: 'item-a',
        catalogHash: DUMMY_HASH_B,
        revision: 1,
      }),
    );

    const refreshRes = await fetch(`http://127.0.0.1:${handle.port}/refresh`, { method: 'POST' });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { object_id: string };
    expect(refreshed.object_id).not.toBe(before.objectId);

    const after = handle.current()!;
    expect(after.objectId).toBe(refreshed.object_id);
    expect(after.objectId).not.toBe(before.objectId);
    expect(after.catalogHash).not.toBe(before.catalogHash);

    // old signed file still readable and unchanged; new one present too.
    const oldFile = ctx.store.getObject(before.objectId);
    expect(oldFile).toBeDefined();
    expect((oldFile!.body as { catalog_hash: string }).catalog_hash).toBe(before.catalogHash);
    expect(ctx.store.getObject(after.objectId)).toBeDefined();
  });

  it('acceptance 5: HTTP surface (/healthz, /catalog, /listing-ref, /refresh, /catalogs/:hash)', async () => {
    const membersDir = tmpDir('station-int-members-');
    dirs.push(membersDir);
    const member = loadOrCreateSeed(join(membersDir, 'member.seed'));

    const { ctx } = await buildIntegratorCtx({
      theme: '五金',
      tags: ['螺栓'],
      members: [
        writeMemberFile(
          membersDir,
          'member.json',
          makeMemberRef({
            publisher: 'member',
            secretKey: member.secretKey,
            catalogId: 'cat-a',
            itemId: 'item-a',
            catalogHash: DUMMY_HASH_A,
          }),
        ),
      ],
      reseed: false,
      announce_to: [],
    });
    ctx.store.saveKey('member', member.secretKey);

    const handle = await startIntegrator(ctx);
    const current = handle.current()!;
    const base = `http://127.0.0.1:${handle.port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, role: 'integrator', agentId: ctx.agentId });

    const catalog = await fetch(`${base}/catalog`);
    expect(catalog.status).toBe(200);
    expect(((await catalog.json()) as { manifest: unknown }).manifest).toBeDefined();

    const ref = await fetch(`${base}/listing-ref`);
    expect(ref.status).toBe(200);
    const refBody = (await ref.json()) as SignedFile;
    expect(refBody.object_type).toBe('LISTING_REF');
    expect((refBody.body as { catalog_hash: string }).catalog_hash).toBe(current.catalogHash);

    const archive = await fetch(`${base}/catalogs/${current.catalogHash}`);
    expect(archive.status).toBe(200);
    expect(((await archive.json()) as { manifest: unknown }).manifest).toBeDefined();

    const refresh = await fetch(`${base}/refresh`, { method: 'POST' });
    expect(refresh.status).toBe(200);
    expect(((await refresh.json()) as { status: string }).status).toBe('refreshed');

    const missing = await fetch(`${base}/catalogs/sha256:${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);

    const unknown = await fetch(`${base}/nope`);
    expect(unknown.status).toBe(404);

    // wrong method on /refresh → 405
    const badMethod = await fetch(`${base}/refresh`, { method: 'GET' });
    expect(badMethod.status).toBe(405);
  });
});
