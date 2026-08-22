/**
 * Acceptance #2 — local tracker round-trip with DHT disabled:
 * startTracker → seed(dirA, {tracker}) → download(magnet, dirB, {tracker})
 * → verifyCatalogFiles passes and catalog hashes are equal.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDirFiles } from '../src/fs.js';
import { buildManifest, catalogHash, verifyCatalogFiles } from '../src/manifest.js';
import type { Roundtrip } from './helpers.js';
import { SEED_DIR_NAME, setupRoundtrip, teardownRoundtrip } from './helpers.js';

describe('acceptance #2 — local tracker round-trip (DHT off)', () => {
  let rt: Roundtrip;

  beforeAll(async () => {
    rt = await setupRoundtrip();
  });

  afterAll(async () => {
    await teardownRoundtrip(rt);
  });

  it('seed → download via magnet + tracker → verify passes, hashes equal', async () => {
    // Expected manifest built from the source directory, using the same
    // relative paths the torrent carries (basename-prefixed).
    const srcFiles = await readDirFiles(rt.seedDir);
    const expected = buildManifest(
      srcFiles.map((f) => ({ path: `${SEED_DIR_NAME}/${f.path}`, data: f.data })),
    );
    expect(rt.manifest).toEqual(expected);
    expect(catalogHash(rt.manifest)).toBe(catalogHash(expected));

    // Files actually on disk in the destination must verify against the manifest.
    const dlFiles = await readDirFiles(rt.destDir);
    expect(verifyCatalogFiles(dlFiles, rt.manifest)).toBe(true);

    // Seeder output sanity.
    expect(rt.seeder.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(rt.seeder.magnetURI).toContain(`xt=urn:btih:${rt.seeder.infoHash}`);
    expect(rt.seeder.magnetURI).toContain('tr=');
    expect(rt.seeder.torrentFile.length).toBeGreaterThan(0);
  });
});
