/**
 * M8 acceptance 5: catalog archive mirror.
 *
 * PUT /catalogs/:hash stores an archive after manifest verification; GET
 * returns the exact raw body (byte-identical round trip); packages whose
 * files fail verifyCatalogFiles (or whose hash does not match the manifest)
 * are rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyCatalogFiles } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';

import { Indexer } from '../src/indexer.js';
import { startIndexerServer } from '../src/server.js';
import { defaultWeights, makeCatalogFixture, rmDir } from './helpers.js';

let dir: string;
let indexer: Indexer;
let http: { port: number; close(): Promise<void> };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idx-catalog-'));
  indexer = new Indexer({ dir, weights: defaultWeights(), indexerId: 'demo-indexer' });
  http = await startIndexerServer(indexer, 0);
});

afterEach(async () => {
  await http.close();
  indexer.close();
  rmDir(dir);
});

describe('acceptance 5: catalog archive mirror', () => {
  it('PUT then GET round-trips the archive byte-identically', async () => {
    const fixture = makeCatalogFixture([
      { path: 'docs/readme.txt', data: new TextEncoder().encode('hello demo-indexer') },
      { path: 'docs/blob.bin', data: Uint8Array.from([0, 1, 2, 254, 255]) },
    ]);

    const put = await fetch(`http://127.0.0.1:${http.port}/catalogs/${fixture.hash}`, {
      method: 'PUT',
      body: fixture.rawBody,
    });
    expect(put.status).toBe(201);

    const get = await fetch(`http://127.0.0.1:${http.port}/catalogs/${fixture.hash}`);
    expect(get.status).toBe(200);
    const raw = await get.text();
    expect(raw).toBe(fixture.rawBody); // byte-identical round trip

    // the served archive still verifies against the manifest
    const served = JSON.parse(raw) as { manifest: Manifest; files: { path: string; content: string }[] };
    const files = served.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
    expect(verifyCatalogFiles(files, served.manifest)).toBe(true);
    // decoded file bytes match the originals exactly
    const readme = files.find((f) => f.path === 'docs/readme.txt')!;
    expect(new TextDecoder().decode(readme.data)).toBe('hello demo-indexer');
    const blob = files.find((f) => f.path === 'docs/blob.bin')!;
    expect(Array.from(blob.data)).toEqual([0, 1, 2, 254, 255]);
  });

  it('a package whose file content does not match the manifest is rejected', async () => {
    const fixture = makeCatalogFixture([
      { path: 'a.txt', data: new TextEncoder().encode('original') },
    ]);
    const tampered = JSON.parse(fixture.rawBody) as { manifest: Manifest; files: { path: string; content: string }[] };
    tampered.files[0]!.content = Buffer.from('tampered bytes').toString('base64'); // same path, different content

    const put = await fetch(`http://127.0.0.1:${http.port}/catalogs/${fixture.hash}`, {
      method: 'PUT',
      body: JSON.stringify(tampered),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('manifest_verification_failed');
    // nothing was stored
    const get = await fetch(`http://127.0.0.1:${http.port}/catalogs/${fixture.hash}`);
    expect(get.status).toBe(404);
  });

  it('a catalog_hash that does not match the manifest is rejected', async () => {
    const fixture = makeCatalogFixture([{ path: 'a.txt', data: new TextEncoder().encode('x') }]);
    const wrongHash = 'sha256:' + '0'.repeat(64);
    const put = await fetch(`http://127.0.0.1:${http.port}/catalogs/${wrongHash}`, {
      method: 'PUT',
      body: fixture.rawBody,
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('catalog_hash_mismatch');
  });

  it('a non-canonical manifest (unsorted files) is rejected', async () => {
    const data = (s: string) => new TextEncoder().encode(s);
    const fixture = makeCatalogFixture([
      { path: 'z.txt', data: data('z') },
      { path: 'a.txt', data: data('a') },
    ]);
    // reorder files in the manifest → violates canonical byte-order sort
    const body = JSON.parse(fixture.rawBody) as { manifest: Manifest; files: { path: string; content: string }[] };
    body.manifest.files.reverse();

    const put = await fetch(`http://127.0.0.1:${http.port}/catalogs/${fixture.hash}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('invalid_manifest');
  });

  it('an invalid catalog_hash format is rejected', async () => {
    const fixture = makeCatalogFixture([{ path: 'a.txt', data: new TextEncoder().encode('x') }]);
    const put = await fetch(`http://127.0.0.1:${http.port}/catalogs/not-a-hash`, {
      method: 'PUT',
      body: fixture.rawBody,
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe('invalid_catalog_hash');
  });

  it('GET for an unknown catalog returns 404', async () => {
    const get = await fetch(`http://127.0.0.1:${http.port}/catalogs/sha256:${'9'.repeat(64)}`);
    expect(get.status).toBe(404);
  });

  it('core API mirrors the same bytes (no HTTP involved)', () => {
    const fixture = makeCatalogFixture([{ path: 'a.txt', data: new TextEncoder().encode('api') }]);
    indexer.storeCatalog(fixture.hash, fixture.rawBody);
    expect(indexer.getCatalog(fixture.hash)).toBe(fixture.rawBody);
  });
});
