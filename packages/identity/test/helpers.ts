import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface VectorIdentity {
  public_key: string;
  seed: string;
}

export interface VectorSignature {
  signer: string;
  algorithm: string;
  signature: string;
  issued_at: string;
}

export interface VectorFile {
  protocol: string;
  object_type: string;
  body: unknown;
  body_hash: string;
  signatures: VectorSignature[];
}

export interface VectorCase {
  name: string;
  object_type: string;
  file: VectorFile;
  object_id?: string;
  expect: string;
}

export interface Vectors {
  spec: string;
  identities: Record<string, VectorIdentity>;
  cases: VectorCase[];
}

/** Load the authoritative test vectors (repo root: protocol/test-vectors/vectors.json). */
export function loadVectors(): Vectors {
  const url = new URL('../../../protocol/test-vectors/vectors.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Vectors;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * signing_input per protocol/specification.md §2:
 *   utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash)
 */
export function signingInput(protocol: string, objectType: string, bodyHash: string): Uint8Array {
  const enc = new TextEncoder();
  return concatBytes(enc.encode(protocol), new Uint8Array([0]), enc.encode(objectType), new Uint8Array([0]), enc.encode(bodyHash));
}
