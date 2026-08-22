/**
 * Acceptance #3 — corruption detection: after a byte-level change (or file
 * removal) in the downloaded directory, verifyCatalogFiles must return false.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDirFiles } from '../src/fs.js';
import { verifyCatalogFiles } from '../src/manifest.js';
import type { Roundtrip } from './helpers.js';
import { SEED_DIR_NAME, setupRoundtrip, teardownRoundtrip } from './helpers.js';

describe('acceptance #3 — corruption detection', () => {
  let rt: Roundtrip;

  beforeAll(async () => {
    rt = await setupRoundtrip();
  });

  afterAll(async () => {
    await teardownRoundtrip(rt);
  });

  it('verify passes on the pristine download', async () => {
    const dlFiles = await readDirFiles(rt.destDir);
    expect(verifyCatalogFiles(dlFiles, rt.manifest)).toBe(true);
  });

  it('verify fails after flipping one byte in a downloaded file', async () => {
    const target = path.join(rt.destDir, SEED_DIR_NAME, 'sub', 'b.bin');
    const buf = await fs.promises.readFile(target);
    buf[0] = buf[0]! ^ 0xff;
    await fs.promises.writeFile(target, buf);
    const dlFiles = await readDirFiles(rt.destDir);
    expect(verifyCatalogFiles(dlFiles, rt.manifest)).toBe(false);
  });

  it('verify fails when a manifest file is deleted', async () => {
    await fs.promises.rm(path.join(rt.destDir, SEED_DIR_NAME, 'a.txt'));
    const dlFiles = await readDirFiles(rt.destDir);
    expect(verifyCatalogFiles(dlFiles, rt.manifest)).toBe(false);
  });
});
