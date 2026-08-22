/**
 * @agent-trade/station — integrator member loading (module S4).
 *
 * Members are configured as LISTING_REF file paths or http(s) URLs. Each is
 * read/fetched, parsed, and verified with `verifyFile` (M2, in §3 order) using
 * the M3 trust ring: a member's public key resolves from `store.saveKey`-saved
 * seeds or from the read-only `.data/peers/<agentId>.pub` public-key imports.
 * Members whose public key cannot be resolved, or whose envelope fails any
 * verification step, are excluded and reported so the caller can log them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { publicKeyFromSeed } from '@agent-trade/identity';
import { parse, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import type { StationContext } from '../../types.js';

const HTTP_URL_RE = /^https?:\/\//i;
const PEERS_REL = join('.data', 'peers');
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** A member whose LISTING_REF verified and whose body was extracted. */
export interface VerifiedMember {
  listingRef: SignedFile;
  publisher: string;
  catalog_id: string;
  catalog_hash: string;
  item_id: string;
  item_revision?: number;
  /** magnet distribution ref (may be absent) — used for reseed. */
  magnetURI?: string;
}

export type MemberLoadResult =
  | { ok: true; member: VerifiedMember }
  | { ok: false; ref: string; reason: string };

/**
 * Build the member signer resolver over the M3 trust ring. Saved secret keys
 * (via `store.saveKey`) are preferred; the read-only `.data/peers/<id>.pub`
 * public-key imports fill any missing signer, exactly as the store's own ring
 * does — without ever overriding a locally-derived key.
 */
export function buildResolveKey(ctx: StationContext): (signer: string) => string | undefined {
  return (signer) => {
    const seed = ctx.store.getKey(signer);
    if (seed !== undefined) return publicKeyFromSeed(seed);

    const peerFile = join(ctx.dataDir, PEERS_REL, `${encodeURIComponent(signer)}.pub`);
    if (existsSync(peerFile)) {
      const publicKey = readFileSync(peerFile, 'utf8').trim();
      if (PUBKEY_RE.test(publicKey)) return publicKey;
    }
    return undefined;
  };
}

/** Read the LISTING_REF text from a file path or an http(s) URL. */
async function fetchRefText(ref: string): Promise<string> {
  if (HTTP_URL_RE.test(ref)) {
    const res = await fetch(ref);
    if (!res.ok) {
      throw new Error(`http ${res.status}`);
    }
    return await res.text();
  }
  return await readFile(resolve(ref), 'utf8');
}

/** Extract the LISTING_REF body fields (schema-verified after `verifyFile`). */
interface ListingRefBody {
  publisher: string;
  catalog_id: string;
  catalog_hash: string;
  item_id: string;
  item_revision?: number;
  distribution_refs?: { type: string; uri: string }[];
}

/**
 * Load and verify one member LISTING_REF. Returns `ok: false` (never throws)
 * for read failures, wrong object type, or any `verifyFile` failure — including
 * `fail:unknown_signer`, which is how "no resolvable public key" surfaces.
 */
export async function loadMember(
  ref: string,
  ctx: StationContext,
  resolveKey: (signer: string) => string | undefined,
): Promise<MemberLoadResult> {
  let file: SignedFile;
  try {
    const text = await fetchRefText(ref);
    file = parse(text);
  } catch (err) {
    return { ok: false, ref, reason: `read_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (file.object_type !== 'LISTING_REF') {
    return { ok: false, ref, reason: `wrong_object_type: ${String(file.object_type)}` };
  }

  let verify: string;
  try {
    verify = verifyFile(file, resolveKey);
  } catch (err) {
    return { ok: false, ref, reason: `verify_threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (verify !== 'valid') {
    return { ok: false, ref, reason: `verify: ${verify}` };
  }

  const body = file.body as ListingRefBody;
  const magnetURI = (body.distribution_refs ?? []).find((d) => d.type === 'magnet')?.uri;

  return {
    ok: true,
    member: {
      listingRef: file,
      publisher: body.publisher,
      catalog_id: body.catalog_id,
      catalog_hash: body.catalog_hash,
      item_id: body.item_id,
      item_revision: body.item_revision,
      magnetURI,
    },
  };
}

/**
 * Filter convenience: split a list of `MemberLoadResult`s into verified members
 * and rejected `{ ref, reason }` pairs, keeping deterministic order.
 */
export function partitionMembers(results: MemberLoadResult[]): {
  members: VerifiedMember[];
  rejected: { ref: string; reason: string }[];
} {
  const members: VerifiedMember[] = [];
  const rejected: { ref: string; reason: string }[] = [];
  for (const result of results) {
    if (result.ok) {
      members.push(result.member);
    } else {
      rejected.push({ ref: result.ref, reason: result.reason });
    }
  }
  return { members, rejected };
}
