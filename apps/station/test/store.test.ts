/**
 * S1 acceptance 4: two stations on different data_dir do not interfere
 * (each M3 store keeps its own `.data/` layout).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateIdentity } from '@agent-trade/identity';
import { openStore } from '@agent-trade/local-store';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('acceptance 4: data dir isolation', () => {
  it('two different data_dir stores do not interfere', () => {
    dir = mkdtempSync(join(tmpdir(), 'station-iso-'));
    const storeA = openStore(join(dir, 'a'));
    const storeB = openStore(join(dir, 'b'));
    try {
      const idA = generateIdentity();
      const idB = generateIdentity();
      storeA.saveKey('agent-a', idA.secretKey);
      storeB.saveKey('agent-b', idB.secretKey);

      expect(storeA.getKey('agent-a')).toBe(idA.secretKey);
      expect(storeA.getKey('agent-b')).toBeUndefined();
      expect(storeB.getKey('agent-b')).toBe(idB.secretKey);
      expect(storeB.getKey('agent-a')).toBeUndefined();
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
