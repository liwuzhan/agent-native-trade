import { jcs, sha256Hex, verify } from '@agent-trade/identity';

import { validateStructure } from './schema.js';
import { objectId, signingInputBytes } from './sign.js';
import type { SignedFile, VerifyResult } from './types.js';
import { PROTOCOL } from './types.js';

/**
 * Four-step verification, strictly in specification.md §3 order. No step may
 * be skipped: an implementation that only runs ④ is equivalent to no
 * verification (the deal-tampered-body-keep-hash vector exists for exactly
 * this regression).
 *
 *   0. protocol === 'agent-trade/0.2'            else fail:protocol_version
 *   ①  recompute sha256(JCS(body)) vs body_hash   else fail:body_hash_mismatch
 *   ②  recompute object_id vs declared (if any)   else fail:object_id_mismatch
 *   ③  body/envelope passes object_type schema    else fail:schema_invalid
 *   ④  verify every signature (strict RFC 8032)   else fail:unknown_signer /
 *                                                   fail:signature_invalid
 */
export function verifyFile(file: SignedFile, resolveKey: (signer: string) => string | undefined): VerifyResult {
  // 0. version policy: exact match only
  if (file.protocol !== PROTOCOL) return 'fail:protocol_version';

  // ① body_hash — recompute from the actual body; skipping this is the
  //    "改 body 不改 hash" attack the vectors guard against.
  let actual: string;
  try {
    actual = 'sha256:' + sha256Hex(jcs(file.body));
  } catch {
    return 'fail:body_hash_mismatch'; // body not JSON-serializable → cannot match
  }
  if (actual !== file.body_hash) return 'fail:body_hash_mismatch';

  // ② object_id — recompute and compare when the file carries a declaration.
  //    (SignedFile per the card has no object_id field; the check is defensive
  //    for out-of-band declarations, per specification.md §3 ②.)
  const declared = (file as SignedFile & { object_id?: unknown }).object_id;
  if (typeof declared === 'string' && declared !== objectId(file)) return 'fail:object_id_mismatch';

  // ③ JSON Schema (draft 2020-12, ajv-formats) for the object_type
  if (!validateStructure(file)) return 'fail:schema_invalid';

  // ④ per-signature strict RFC 8032 verification over the (①-verified) body_hash
  const input = signingInputBytes(file);
  for (const sig of file.signatures) {
    const publicKey = resolveKey(sig.signer);
    if (typeof publicKey !== 'string' || publicKey.length === 0) return 'fail:unknown_signer';
    let ok = false;
    try {
      ok = verify(input, sig.signature, publicKey);
    } catch {
      ok = false;
    }
    if (!ok) return 'fail:signature_invalid';
  }
  return 'valid';
}
