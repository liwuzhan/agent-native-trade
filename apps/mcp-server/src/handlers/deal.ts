/**
 * DEAL tools — compile / sign / verify. `trade_sign_deal` implements the
 * module-card signing red line as a tool-level constraint:
 *
 *   - accepts ONLY a `deal` envelope object + `expected_body_hash`;
 *   - schema-validates the body, recomputes body_hash and compares it to
 *     `expected_body_hash` BEFORE any signature is produced; mismatch → refuse;
 *   - there is NO generic arbitrary-byte signing interface anywhere in the
 *     tool set (nothing takes a raw message/payload);
 *   - the signing decision is the calling model's: no human confirmation step
 *     exists — the only local guardrails are the schema/hash checks and the
 *     configurable policy (`max_amount_per_deal`);
 *   - the private key is read-only from `.data/keys/` — callers can name a
 *     signer, never supply a key.
 */

import { addSignature, buildObject, objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import type { TradeApp } from '../app.js';
import { checkAmountPolicy } from '../policy.js';
import { validateBody } from '../schema.js';
import { dealAmountOf, isPlainObject, recomputeBodyHash, resolveEnvelope } from '../shared.js';
import type { ToolSummary } from '../shared.js';

const BODY_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function requireBodyHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !BODY_HASH_RE.test(value)) {
    throw new Error(`${label}: expected_body_hash must be "sha256:" + 64 lowercase hex, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** trade_compile_deal — draft the deal once (specification.md §4: 编译只发生一次). */
export async function compileDeal(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  if (!isPlainObject(args.body)) {
    throw new Error(`compile_deal: "body" must be a JSON object (the DEAL body), got ${typeof args.body}`);
  }
  const body = (await validateBody('DEAL', args.body)) as { trade_id?: unknown };
  const draft = buildObject('DEAL', body);
  return {
    object_id: objectId(draft),
    body_hash: draft.body_hash,
    trade_id: body.trade_id,
    object_type: 'DEAL',
    status: 'compiled',
  };
}

/**
 * trade_sign_deal — the red line. Rejects: non-object deal, non-DEAL
 * object_type, body schema failures, body_hash mismatch (recomputed vs
 * expected), inconsistent envelope hash, policy over-budget, and unknown
 * signers (no local key). On success the signed deal is persisted as a fact
 * file and its object_id returned.
 */
export async function signDeal(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  const expected = requireBodyHash(args.expected_body_hash, 'sign_deal');
  const deal = args.deal;
  if (!isPlainObject(deal)) {
    // arbitrary bytes / strings / arrays are structurally not an envelope
    throw new Error(`sign_deal: "deal" must be a JSON object (a DEAL envelope), got ${typeof deal} — refusing`);
  }
  const file = deal as unknown as SignedFile;
  if (file.object_type !== 'DEAL') {
    throw new Error(`sign_deal: expected object_type "DEAL", got ${JSON.stringify(file.object_type)} — refusing to sign`);
  }

  // ① schema-validate the body first (red line: 先 Schema 验证 body)
  const body = await validateBody('DEAL', file.body);
  // ② recompute body_hash from the actual body; must equal expected
  const actual = recomputeBodyHash(body);
  if (actual !== expected) {
    throw new Error(`sign_deal: body_hash mismatch — recomputed ${actual} ≠ expected ${expected} (refusing to sign)`);
  }
  // ③ a draft that declares a different hash than the caller expects is
  //    inconsistent — refuse before any signature exists
  if (file.body_hash !== undefined && file.body_hash !== expected) {
    throw new Error(`sign_deal: envelope body_hash ${file.body_hash} ≠ expected_body_hash ${expected} (inconsistent draft)`);
  }

  // policy guardrail (configurable, local)
  const policyError = checkAmountPolicy(app.policy, dealAmountOf(body));
  if (policyError !== null) {
    throw new Error(`sign_deal: ${policyError}`);
  }

  // ④ sign with a LOCAL private key only — never one supplied by the caller
  const signer = typeof args.signer === 'string' && args.signer.length > 0 ? (args.signer as string) : app.agentId;
  const secretKey = app.secretKeyOf(signer);
  if (secretKey === undefined) {
    throw new Error(
      `sign_deal: no private key for "${signer}" under .data/keys/ — keys are read-only and never accepted from callers`,
    );
  }
  // Preserve any existing signatures (multi-party signing: 增签不破旧签).
  const signatures = Array.isArray(file.signatures) ? file.signatures : [];
  const signed = addSignature({ ...file, body, body_hash: expected, signatures }, signer, secretKey);

  // Persist the signed fact (source of truth). putObject runs the full
  // four-step verification first and throws unless 'valid', so an invalid
  // result can never be stored.
  const id = app.store.putObject(signed);
  return { object_id: id, body_hash: expected, signer, object_type: 'DEAL', status: 'signed' };
}

/**
 * trade_verify_deal — full four-step verification (specification.md §3),
 * against the local trust ring. Accepts either the envelope itself or the
 * object_id of a previously stored deal. Only DEAL objects are accepted.
 */
export function verifyDeal(args: Record<string, unknown>, app: TradeApp): ToolSummary {
  const file = resolveEnvelope(app, args.deal, args.object_id, 'verify_deal');
  if (file.object_type !== 'DEAL') {
    throw new Error(`verify_deal: expected a DEAL object, got ${JSON.stringify(file.object_type)}`);
  }
  return { object_id: objectId(file), object_type: 'DEAL', result: verifyFile(file, app.resolveKey) };
}
