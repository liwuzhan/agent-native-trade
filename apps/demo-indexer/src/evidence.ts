/**
 * Evidence verification for receipt intake (module M8).
 *
 * Order (per card): bundle first, online fetch as fallback, both with strict
 * limits. The *tier* decided here is a fact about the receipt; weights only
 * re-price it later.
 *
 *   - 'bundle':     evidence.bundle is present and EVERY entry passes M2
 *                   verifyFile → strongest disclosure tier.
 *   - 'referenced': no valid bundle, but deal_ref is reachable — found in the
 *                   local store, or fetched online (timeout + size cap) and
 *                   matching object_id + body_hash.
 *   - 'none':       no bundle / no deal_ref, or the reference is unreachable.
 *                   The receipt may still be indexed at the low tier.
 */

import { jcs, sha256Hex } from '@agent-trade/identity';
import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile, VerifyResult } from '@agent-trade/signed-files';

import type { EvidenceTier } from './types.js';

export interface EvidenceBody {
  deal_ref?: { object_id?: string; body_hash?: string; distribution_refs?: unknown } | null;
  settlement_event_ref?: string;
  logistics_event_ref?: string;
  bundle?: unknown;
}

export interface EvidenceOptions {
  evidence: EvidenceBody | undefined;
  resolveKey: (signer: string) => string | undefined;
  /** Local fact store lookup by object_id (signed fact files, e.g. store.getObject). */
  getLocalObject?: (objectId: string) => SignedFile | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface EvidenceResult {
  tier: EvidenceTier;
  detail: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** True when `value` looks like a signed envelope (has body + body_hash). */
function looksSigned(v: unknown): v is SignedFile {
  return typeof v === 'object' && v !== null && (v as SignedFile).body !== undefined && typeof (v as SignedFile).body_hash === 'string';
}

function verifyBundle(entries: unknown, resolveKey: (signer: string) => string | undefined): VerifyResult | 'not-applicable' {
  if (!Array.isArray(entries) || entries.length === 0) return 'not-applicable';
  for (const entry of entries) {
    if (!looksSigned(entry)) return 'fail:schema_invalid';
    const result = verifyFile(entry, resolveKey);
    if (result !== 'valid') return result;
  }
  return 'valid';
}

/** Fetch a URL with a hard timeout and a hard response-size cap; bytes on success. */
export async function fetchWithLimits(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch {
    return undefined; // DNS/connection refused/timeout → unreachable
  }
  if (!res.ok || res.body === null) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return undefined;
    }
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined; // over the size cap → treat as unusable evidence
    }
    chunks.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Does the fetched object actually match the deal_ref claims? */
function matchesDealRef(obj: SignedFile, objectIdClaim: string, bodyHashClaim: string): boolean {
  try {
    const actualBodyHash = 'sha256:' + sha256Hex(jcs(obj.body));
    const actualObjectId = objectId(obj);
    return actualBodyHash === bodyHashClaim && actualObjectId === objectIdClaim;
  } catch {
    return false;
  }
}

export async function verifyEvidence(options: EvidenceOptions): Promise<EvidenceResult> {
  const { evidence, resolveKey, getLocalObject } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  // 1. bundle first — strongest disclosure tier
  const bundleResult = verifyBundle(evidence?.bundle, resolveKey);
  if (bundleResult === 'valid') {
    return { tier: 'bundle', detail: 'bundle present, all entries verify' };
  }

  // 2. deal_ref reachability — local store first, then online fetch (fallback)
  const dealRef = evidence?.deal_ref;
  if (dealRef !== undefined && dealRef !== null && typeof dealRef === 'object') {
    const objectIdClaim = typeof dealRef.object_id === 'string' ? dealRef.object_id : undefined;
    const bodyHashClaim = typeof dealRef.body_hash === 'string' ? dealRef.body_hash : undefined;
    if (objectIdClaim !== undefined && bodyHashClaim !== undefined) {
      // 2a. already in our local fact store?
      const local = getLocalObject?.(objectIdClaim);
      if (local !== undefined && matchesDealRef(local, objectIdClaim, bodyHashClaim)) {
        return { tier: 'referenced', detail: 'deal_ref found in local store' };
      }
      // 2b. online fetch fallback (timeout + size cap)
      const refs = Array.isArray(dealRef.distribution_refs) ? dealRef.distribution_refs.filter((u): u is string => typeof u === 'string') : [];
      for (const url of refs) {
        const bytes = await fetchWithLimits(url, fetchImpl, timeoutMs, maxBytes);
        if (bytes === undefined) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          continue;
        }
        if (looksSigned(obj) && matchesDealRef(obj, objectIdClaim, bodyHashClaim)) {
          return { tier: 'referenced', detail: `deal_ref fetched online (${url})` };
        }
      }
      return { tier: 'none', detail: 'deal_ref present but unreachable (no bundle, not local, fetch failed/over cap)' };
    }
    return { tier: 'none', detail: 'deal_ref malformed (missing object_id/body_hash)' };
  }

  // 3. no evidence or no deal_ref
  if (bundleResult !== 'not-applicable') {
    return { tier: 'none', detail: `bundle present but invalid (${bundleResult})` };
  }
  return { tier: 'none', detail: 'no evidence bundle and no deal_ref' };
}
