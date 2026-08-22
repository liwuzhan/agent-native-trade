/**
 * Weight config loading/validation (module M8). All scoring rules live in a
 * JSON config file; different configs must produce different scores.
 */

import { readFileSync } from 'node:fs';

import { jcs, sha256Hex } from '@agent-trade/identity';

import type { Weights } from './types.js';

const RATINGS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'FACT_ONLY'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a parsed weights object; throws with a precise message on violation. */
export function assertWeights(v: unknown): asserts v is Weights {
  if (!isRecord(v)) throw new Error('weights: expected a JSON object');
  const scores = v.scores;
  if (!isRecord(scores)) throw new Error('weights: missing "scores" object');
  const evidence = scores.evidence;
  if (!isRecord(evidence)) throw new Error('weights: missing "scores.evidence" object');
  for (const key of ['bundle', 'referenced', 'none'] as const) {
    if (typeof evidence[key] !== 'number' || !Number.isFinite(evidence[key])) {
      throw new Error(`weights: scores.evidence.${key} must be a finite number`);
    }
  }
  for (const key of ['deal_ref_present', 'missing_deal_ref', 'settlement_present', 'missing_settlement'] as const) {
    if (typeof scores[key] !== 'number' || !Number.isFinite(scores[key])) {
      throw new Error(`weights: scores.${key} must be a finite number`);
    }
  }
  if (typeof v.require_deal_ref !== 'boolean') throw new Error('weights: require_deal_ref must be a boolean');
  if (typeof v.require_settlement_event !== 'boolean') throw new Error('weights: require_settlement_event must be a boolean');
  if (!isRecord(scores.rating)) throw new Error('weights: missing "scores.rating" object');
  for (const rating of RATINGS) {
    const n = scores.rating[rating];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`weights: scores.rating.${rating} must be a finite number`);
    }
  }
}

/** Parse + validate weights JSON text. */
export function parseWeights(text: string): Weights {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`weights: invalid JSON (${(err as Error).message})`);
  }
  assertWeights(parsed);
  return parsed;
}

/** Load weights from a file path. */
export function loadWeights(path: string): Weights {
  return parseWeights(readFileSync(path, 'utf8'));
}

/**
 * Deterministic fingerprint of the weight config, so a snapshot records which
 * rules produced its scores (JCS over the raw JSON object, protocol §2 rule).
 */
export function weightsHash(weights: Weights): string {
  return 'sha256:' + sha256Hex(jcs(weights));
}

/**
 * Price one receipt from its stored structural facts with the *current*
 * weights. The evidence tier is a fact decided at intake; weights re-price it.
 */
export function priceReceipt(facts: {
  evidence_tier: 'bundle' | 'referenced' | 'none';
  has_deal_ref: boolean;
  has_settlement_event: boolean;
  rating: string;
}, weights: Weights): { evidence_score: number; score: number } {
  const evidence_score = weights.scores.evidence[facts.evidence_tier] ?? 0;
  const dealRefComponent = facts.has_deal_ref
    ? weights.scores.deal_ref_present
    : weights.require_deal_ref
      ? weights.scores.missing_deal_ref
      : 0;
  const settlementComponent = facts.has_settlement_event
    ? weights.scores.settlement_present
    : weights.require_settlement_event
      ? weights.scores.missing_settlement
      : 0;
  const ratingScore = weights.scores.rating[facts.rating] ?? 0;
  return { evidence_score, score: evidence_score + dealRefComponent + settlementComponent + ratingScore };
}
