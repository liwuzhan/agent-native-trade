/**
 * Shared envelope + response helpers for the MCP tools.
 *
 * Response contract (module card M9 acceptance): every tool returns a SHORT
 * summary + `object_id`, never full files or history, so context stays small.
 * `ok()` hard-fails on an over-long summary — a loud bug beats silent context
 * bloat.
 */

import { jcs, sha256Hex } from '@agent-trade/identity';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { SignedFile } from '@agent-trade/signed-files';

/** Hard cap on any tool response text (card acceptance: < 500 chars). */
export const MAX_RESPONSE_CHARS = 500;

export interface ToolSummary {
  object_id: string;
  [key: string]: unknown;
}

export function ok(summary: ToolSummary): CallToolResult {
  const text = JSON.stringify(summary);
  if (text.length >= MAX_RESPONSE_CHARS) {
    throw new Error(`internal error: tool summary too long (${text.length} chars >= ${MAX_RESPONSE_CHARS})`);
  }
  return { content: [{ type: 'text', text }], structuredContent: summary };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recompute the body_hash of a body exactly as `buildObject` does:
 * `"sha256:" + lowerhex(SHA-256(utf8(JCS(body))))` (specification.md §2).
 */
export function recomputeBodyHash(body: unknown): string {
  return 'sha256:' + sha256Hex(jcs(body));
}

/** True when `id` looks like a signed-object id (`sha256:` + 64 lowercase hex). */
export function isObjectId(id: unknown): id is string {
  return typeof id === 'string' && /^sha256:[0-9a-f]{64}$/.test(id);
}

export interface DealBody {
  trade_id?: unknown;
  settlement?: { amount?: unknown };
}

/** Read `settlement.amount` as a string; undefined when absent/not a string. */
export function dealAmountOf(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const settlement = body.settlement;
  if (!isPlainObject(settlement)) return undefined;
  const amount = settlement.amount;
  return typeof amount === 'string' ? amount : undefined;
}

/**
 * Coerce a tool argument that may be either a full signed envelope object or
 * an object_id string into the envelope, reading from the store when only an
 * id was given. At most one of the two may be provided.
 */
export function resolveEnvelope(
  app: { store: { getObject(id: string): SignedFile | undefined } },
  deal: unknown,
  objectId: unknown,
  label: string,
): SignedFile {
  const hasDeal = deal !== undefined;
  const hasId = isObjectId(objectId);
  if (hasDeal === hasId) {
    throw new Error(`${label}: provide exactly one of "deal" (envelope object) or "object_id" (stored fact)`);
  }
  if (hasId) {
    const file = app.store.getObject(objectId);
    if (file === undefined) throw new Error(`${label}: no stored object with id ${objectId}`);
    return file;
  }
  if (!isPlainObject(deal)) {
    throw new Error(`${label}: "deal" must be a JSON object (a signed envelope), got ${typeof deal}`);
  }
  return deal as unknown as SignedFile;
}
