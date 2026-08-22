/**
 * Shared test helpers: temp dirs, recursive reads, and a reusable
 * tracker-only seed→download round-trip.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { download } from '../src/download.js';
import { readDirFiles, makeTempDir, rmDir } from '../src/fs.js';
import { buildManifest } from '../src/manifest.js';
import type { Manifest } from '../src/manifest.js';
import { seed } from '../src/seed.js';
import type { SeedResult } from '../src/seed.js';
import { startTracker } from '../src/tracker.js';
import type { TrackerHandle } from '../src/tracker.js';

export { readDirFiles, makeTempDir, rmDir, buildManifest };

/** Basename of the seeded directory; torrent file paths are prefixed with it. */
export const SEED_DIR_NAME = 'catalog-a';

export interface Roundtrip {
  tracker: TrackerHandle;
  announceUrl: string;
  /** the seeded directory (contains the catalog files) */
  seedDir: string;
  /** parent of seedDir (for cleanup) */
  srcParent: string;
  /** download destination directory */
  destDir: string;
  seeder: SeedResult;
  manifest: Manifest;
}

/**
 * Full tracker-only round-trip (DHT disabled): start a local tracker, seed a
 * small directory, download it via the magnet URI, return everything.
 */
export async function setupRoundtrip(): Promise<Roundtrip> {
  const tracker = await startTracker(0);
  try {
    const announceUrl = `http://127.0.0.1:${tracker.port}/announce`;
    const srcParent = await makeTempDir('bt-catalog-src-');
    const destDir = await makeTempDir('bt-catalog-dst-');
    const seedDir = path.join(srcParent, SEED_DIR_NAME);
    await fs.promises.mkdir(path.join(seedDir, 'sub'), { recursive: true });
    await fs.promises.writeFile(path.join(seedDir, 'a.txt'), 'hello world\n');
    await fs.promises.writeFile(path.join(seedDir, 'sub', 'b.bin'), Buffer.from([0, 1, 2, 250, 255]));
    await fs.promises.writeFile(path.join(seedDir, 'empty.txt'), '');
    const seeder = await seed(seedDir, { tracker: [announceUrl], dht: false });
    const manifest = await download(seeder.magnetURI, destDir, { tracker: [announceUrl], dht: false });
    return { tracker, announceUrl, seedDir, srcParent, destDir, seeder, manifest };
  } catch (err) {
    await tracker.close();
    throw err;
  }
}

export async function teardownRoundtrip(rt: Roundtrip): Promise<void> {
  await rt.seeder.stop();
  await rt.tracker.close();
  await rmDir(rt.srcParent);
  await rmDir(rt.destDir);
}
