/**
 * Static snapshot sign/verify (module M8).
 *
 * The snapshot is plain JSON + a detached signature file, reusing the M2
 * envelope *layout* (specification.md §2): signing_input =
 * utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash).
 * The object_type is the protocol-external "INDEX_SNAPSHOT" (site-local
 * decision, registered in the module report). The site's own public key is
 * carried inside the snapshot body so the detached signature can be verified
 * fully offline and self-contained.
 */

import { jcs, sha256Hex, sign as edSign, verify as edVerify } from '@agent-trade/identity';

import { INDEX_SNAPSHOT_TYPE } from './types.js';
import type { DetachedSignature, IndexSnapshot, SnapshotVerifyResult, SubjectView, Weights } from './types.js';
import { weightsHash } from './weights.js';

export const PROTOCOL = 'agent-trade/0.2';

/** The same byte layout as protocol §2 — replicated here because M2 does not
 *  export signingInputBytes (report decision). */
export function snapshotSigningInput(protocol: string, objectType: string, bodyHash: string): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(protocol), new Uint8Array([0]), enc.encode(objectType), new Uint8Array([0]), enc.encode(bodyHash)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Stable content hash of the aggregation (independent of generated_at). */
export function snapshotHash(indexerId: string, weights: Weights, subjects: SubjectView[]): string {
  return 'sha256:' + sha256Hex(jcs({ indexer_id: indexerId, weights_hash: weightsHash(weights), subjects }));
}

/** Build the unsigned snapshot from a list of subject views. */
export function buildSnapshot(opts: {
  indexerId: string;
  indexerPublicKey: string;
  weights: Weights;
  subjects: SubjectView[];
  generatedAt?: string;
}): IndexSnapshot {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const body = {
    indexer_id: opts.indexerId,
    indexer_public_key: opts.indexerPublicKey,
    weights_hash: weightsHash(opts.weights),
    generated_at,
    snapshot_hash: snapshotHash(opts.indexerId, opts.weights, opts.subjects),
    subjects: opts.subjects,
  };
  const body_hash = 'sha256:' + sha256Hex(jcs(body));
  return { protocol: PROTOCOL, object_type: INDEX_SNAPSHOT_TYPE, body, body_hash };
}

/** Sign the snapshot into a detached .sig file. */
export function signSnapshot(
  snapshot: IndexSnapshot,
  signer: string,
  secretKey: string,
  issuedAt?: string,
): DetachedSignature {
  const input = snapshotSigningInput(snapshot.protocol, snapshot.object_type, snapshot.body_hash);
  return {
    protocol: snapshot.protocol,
    object_type: snapshot.object_type,
    body_hash: snapshot.body_hash,
    signer,
    algorithm: 'Ed25519',
    signature: edSign(input, secretKey),
    issued_at: issuedAt ?? new Date().toISOString(),
  };
}

/**
 * Four-step verification mirroring specification.md §3, adapted to the
 * protocol-external snapshot (no JSON-Schema step — the snapshot shape is
 * validated structurally here).
 */
export function verifySnapshot(snapshot: IndexSnapshot, signature: DetachedSignature): SnapshotVerifyResult {
  // 0. version policy: exact match only
  if (snapshot.protocol !== PROTOCOL || signature.protocol !== PROTOCOL) return 'fail:protocol_version';
  // type policy: protocol-external object type, this site only
  if (snapshot.object_type !== INDEX_SNAPSHOT_TYPE || signature.object_type !== INDEX_SNAPSHOT_TYPE) {
    return 'fail:type_mismatch';
  }
  // ① body_hash — recompute from the actual body
  let actual: string;
  try {
    actual = 'sha256:' + sha256Hex(jcs(snapshot.body));
  } catch {
    return 'fail:body_hash_mismatch';
  }
  if (actual !== snapshot.body_hash) return 'fail:body_hash_mismatch';
  // ② object_id — defensive compare when a declaration is carried
  const declared = (snapshot as IndexSnapshot & { object_id?: unknown }).object_id;
  if (typeof declared === 'string') {
    const input = snapshotSigningInput(snapshot.protocol, snapshot.object_type, snapshot.body_hash);
    const recomputed = 'sha256:' + sha256Hex(input);
    if (declared !== recomputed) return 'fail:body_hash_mismatch';
  }
  // ③ structural shape (the snapshot's own schema)
  const key = snapshot.body.indexer_public_key;
  if (typeof key !== 'string' || key.length === 0) return 'fail:signature_invalid';
  if (!Array.isArray(snapshot.body.subjects)) return 'fail:signature_invalid';
  // ④ detached signature over the (①-verified) body_hash
  if (signature.body_hash !== snapshot.body_hash) return 'fail:sig_body_hash_mismatch';
  const input = snapshotSigningInput(snapshot.protocol, snapshot.object_type, snapshot.body_hash);
  let ok = false;
  try {
    ok = edVerify(input, signature.signature, key);
  } catch {
    ok = false;
  }
  return ok ? 'valid' : 'fail:signature_invalid';
}

/** Parse a snapshot JSON text (lenient parse; validation happens in verifySnapshot). */
export function parseSnapshot(text: string): IndexSnapshot {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('parseSnapshot: expected a JSON object');
  }
  return value as IndexSnapshot;
}

/** Parse a detached signature JSON text. */
export function parseDetachedSignature(text: string): DetachedSignature {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('parseDetachedSignature: expected a JSON object');
  }
  return value as DetachedSignature;
}

/** Offline query: find the subject view inside an already-verified snapshot. */
export function querySnapshot(snapshot: IndexSnapshot, agentId: string): SubjectView | undefined {
  return snapshot.body.subjects.find((s) => s.agent_id === agentId);
}
