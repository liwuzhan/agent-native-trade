/**
 * demo-indexer shared types (module M8).
 *
 * The snapshot is a protocol-external object: it reuses the agent-trade/0.2
 * envelope *layout* (§2 signing input) but is NOT one of the four protocol
 * object types — it uses the site-local object_type string "INDEX_SNAPSHOT".
 * This decision is registered in the module report (protocol-external, this
 * site only; spec §3 ③ schema step does not apply to it).
 */

import type { SignedFile } from '@agent-trade/signed-files';

/** Snapshot object_type (protocol-external, demo-indexer only). */
export const INDEX_SNAPSHOT_TYPE = 'INDEX_SNAPSHOT' as const;

/** Evidence tiers decided at intake; the tier is a fact, weights only re-price it. */
export type EvidenceTier = 'bundle' | 'referenced' | 'none';

export interface EvidenceScores {
  bundle: number;
  referenced: number;
  none: number;
}

/** All scoring rules for one indexer instance — must live in a JSON config. */
export interface Weights {
  require_deal_ref: boolean;
  require_settlement_event: boolean;
  scores: {
    evidence: EvidenceScores;
    deal_ref_present: number;
    missing_deal_ref: number;
    settlement_present: number;
    missing_settlement: number;
    rating: Record<string, number>;
  };
}

/** Structural facts about one indexed receipt (tier is decided at intake). */
export interface ReceiptRecord {
  receipt_id: string;
  object_id: string;
  body_hash: string;
  subject: string;
  direction: string;
  result: string;
  rating: string;
  issuer: string;
  issued_at: string;
  comment: string | null;
  has_deal_ref: boolean;
  has_settlement_event: boolean;
  evidence_tier: EvidenceTier;
  evidence_detail: string;
  indexed_at: string;
}

export interface ReceiptScore extends ReceiptRecord {
  evidence_score: number;
  score: number;
}

export interface ReceiptSummary {
  receipt_id: string;
  object_id: string;
  subject: string;
  direction: string;
  result: string;
  rating: string;
  issuer: string;
  issued_at: string;
  comment: string | null;
  evidence_tier: EvidenceTier;
  evidence_score: number;
  score: number;
}

/** Aggregated view for one subject, priced with the *current* weights. */
export interface SubjectView {
  agent_id: string;
  score: number;
  receipt_count: number;
  positive: number;
  neutral: number;
  negative: number;
  fact_only: number;
  receipts: ReceiptSummary[];
}

/** Plain-JSON static snapshot (aggregation + snapshot hash), no signature inside. */
export interface IndexSnapshot {
  protocol: string;
  object_type: typeof INDEX_SNAPSHOT_TYPE;
  body: {
    indexer_id: string;
    indexer_public_key: string;
    weights_hash: string;
    generated_at: string;
    /** sha256 over JCS({ indexer_id, weights_hash, subjects }) — stable across exports of the same data. */
    snapshot_hash: string;
    subjects: SubjectView[];
  };
  /** "sha256:" + hex(SHA-256(utf8(JCS(body)))) — same rule as protocol §2. */
  body_hash: string;
}

/** Detached signature file (receipts-index.sig), mirrors protocol §1/§2 layout. */
export interface DetachedSignature {
  protocol: string;
  object_type: typeof INDEX_SNAPSHOT_TYPE;
  body_hash: string;
  signer: string;
  algorithm: 'Ed25519';
  signature: string;
  issued_at: string;
}

export interface SnapshotBundle {
  snapshot: IndexSnapshot;
  signature: DetachedSignature;
}

export type SnapshotVerifyResult =
  | 'valid'
  | 'fail:protocol_version'
  | 'fail:body_hash_mismatch'
  | 'fail:type_mismatch'
  | 'fail:sig_body_hash_mismatch'
  | 'fail:signature_invalid';

/** Result of one receipt submission. */
export type SubmitResult =
  | { status: 'indexed'; record: ReceiptScore; object_id: string }
  | { status: 'duplicate'; record: ReceiptScore; object_id: string }
  | { status: 'conflict'; reason: string };

/** Error surfaced by the indexer core; carries an HTTP-friendly reason. */
export class IndexerError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'IndexerError';
    this.reason = reason;
  }
}

export interface IndexerOptions {
  /** Store directory (local-store .data/ layout lives under it). */
  dir: string;
  /** Active weight config. */
  weights: Weights;
  /** Site identity id; a fresh keypair is generated and persisted on first open. */
  indexerId?: string;
  /** fetch impl override (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Online evidence fetch timeout in ms (default 2000). */
  fetchTimeoutMs?: number;
  /** Online evidence fetch response size cap in bytes (default 256 KiB). */
  fetchMaxBytes?: number;
}

export type { SignedFile };
