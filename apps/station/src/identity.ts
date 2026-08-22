/**
 * @agent-trade/station — station identity from a 32-byte seed file (module S1).
 *
 * The seed file is raw binary (exactly 32 bytes), created with mode 0600 when
 * absent and reused verbatim when present, so restarting a station yields the
 * same agentId/publicKey.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { publicKeyFromSeed } from '@agent-trade/identity';

export interface IdentityResult {
  publicKey: string;
  secretKey: string;
  /** true when the seed file was just created (not reused) */
  created: boolean;
}

export function loadOrCreateSeed(path: string): IdentityResult {
  const seedPath = resolve(path);
  if (existsSync(seedPath)) {
    const bytes = readFileSync(seedPath);
    if (bytes.length !== 32) {
      throw new Error(`identity_seed_file: expected 32 bytes, got ${bytes.length} (${seedPath})`);
    }
    const secretKey = Buffer.from(bytes).toString('base64url');
    return { publicKey: publicKeyFromSeed(secretKey), secretKey, created: false };
  }

  const bytes = randomBytes(32);
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(seedPath, bytes, { mode: 0o600 });
  chmodSync(seedPath, 0o600); // exact mode regardless of umask
  const secretKey = Buffer.from(bytes).toString('base64url');
  return { publicKey: publicKeyFromSeed(secretKey), secretKey, created: true };
}
