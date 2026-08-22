import { jcs, sha256Hex, sign } from '@agent-trade/identity';

import type { ObjectType, SignedFile } from './types.js';
import { PROTOCOL } from './types.js';

/**
 * signing_input = utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash)
 * (specification.md §2). The declared body_hash is used verbatim — never a
 * recomputed one — so that later signatures over an already-signed object stay
 * valid (multi-party signing of one immutable object).
 */
export function signingInputBytes(file: Pick<SignedFile, 'protocol' | 'object_type' | 'body_hash'>): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(file.protocol), new Uint8Array([0]), enc.encode(file.object_type), new Uint8Array([0]), enc.encode(file.body_hash)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build an unsigned envelope: computes body_hash = "sha256:" + lowerhex(SHA-256(utf8(JCS(body))))
 * and starts with an empty signatures array.
 */
export function buildObject(objectType: ObjectType, body: unknown): SignedFile {
  const body_hash = 'sha256:' + sha256Hex(jcs(body));
  return { protocol: PROTOCOL, object_type: objectType, body, body_hash, signatures: [] };
}

/**
 * object_id = "sha256:" + lowerhex(SHA-256(signing_input)) (specification.md §2).
 * Deterministic, no self-referential loop; changes only when protocol,
 * object_type or body_hash change.
 */
export function objectId(file: Pick<SignedFile, 'protocol' | 'object_type' | 'body_hash'>): string {
  return 'sha256:' + sha256Hex(signingInputBytes(file));
}

/**
 * Append one Ed25519 signature (specification.md §1/§2). Appends to
 * signatures[] without touching body/body_hash, so existing signatures stay
 * valid. `issuedAt` defaults to the current UTC time (RFC 3339).
 */
export function addSignature(file: SignedFile, signer: string, secretKey: string, issuedAt?: string): SignedFile {
  const issued_at = issuedAt ?? new Date().toISOString();
  const signature = sign(signingInputBytes(file), secretKey);
  return { ...file, signatures: [...file.signatures, { signer, algorithm: 'Ed25519', signature, issued_at }] };
}
