import { readFileSync } from 'node:fs';

import type { SignedFile, VerifyResult } from '../src/index.js';

/**
 * Test fixtures read straight from the authoritative protocol test-vectors
 * (specification.md: "权威源：protocol/test-vectors/"). Test-only; runtime
 * code never reads repo-relative paths.
 */

export interface VectorIdentity {
  public_key: string;
  seed: string;
}

export interface VectorCase {
  name: string;
  object_type: SignedFile['object_type'];
  file: SignedFile;
  object_id?: string;
  expect: VerifyResult;
  tamper?: string;
}

export interface Vectors {
  spec: string;
  identities: Record<string, VectorIdentity>;
  cases: VectorCase[];
}

export function loadVectors(): Vectors {
  const url = new URL('../../../protocol/test-vectors/vectors.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Vectors;
}

/** resolveKey built from the vectors' identities (signer → public key). */
export function resolveKeyFor(identities: Record<string, VectorIdentity>) {
  return (signer: string): string | undefined => identities[signer]?.public_key;
}
