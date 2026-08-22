/**
 * S1 acceptance 2: identity seed file generation (0600), reuse across restarts,
 * and 32-byte length enforcement.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publicKeyFromSeed } from '@agent-trade/identity';

import { loadOrCreateSeed } from '../src/identity.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-id-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acceptance 2: identity seed file', () => {
  it('generates a 32-byte seed with mode 0600 when absent', () => {
    const seedPath = join(dir, 'seed.key');
    const result = loadOrCreateSeed(seedPath);
    expect(result.created).toBe(true);

    const bytes = readFileSync(seedPath);
    expect(bytes.length).toBe(32);

    const mode = statSync(seedPath).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(result.publicKey).toBe(publicKeyFromSeed(bytes.toString('base64url')));
  });

  it('reuses the same identity on a second start', () => {
    const seedPath = join(dir, 'seed.key');
    const first = loadOrCreateSeed(seedPath);
    const second = loadOrCreateSeed(seedPath);
    expect(second.created).toBe(false);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.secretKey).toBe(first.secretKey);
  });

  it('reads an existing 32-byte seed and derives the matching public key', () => {
    const seedPath = join(dir, 'seed.key');
    const bytes = randomBytes(32);
    writeFileSync(seedPath, bytes, { mode: 0o600 });
    const result = loadOrCreateSeed(seedPath);
    expect(result.created).toBe(false);
    expect(result.publicKey).toBe(publicKeyFromSeed(bytes.toString('base64url')));
  });

  it('rejects a seed file that is not exactly 32 bytes', () => {
    const seedPath = join(dir, 'seed.key');
    writeFileSync(seedPath, randomBytes(31), { mode: 0o600 });
    expect(() => loadOrCreateSeed(seedPath)).toThrow(/identity_seed_file: expected 32 bytes, got 31/);
  });
});
