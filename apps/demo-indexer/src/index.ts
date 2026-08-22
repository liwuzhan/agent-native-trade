/**
 * @agent-trade/demo-indexer — demo indexer (module M8).
 */

export { Indexer } from './indexer.js';
export { createIndexerApp, startIndexerServer } from './server.js';
export type { StartedServer } from './server.js';
export {
  assertWeights,
  loadWeights,
  parseWeights,
  priceReceipt,
  weightsHash,
} from './weights.js';
export {
  buildSnapshot,
  parseDetachedSignature,
  parseSnapshot,
  querySnapshot,
  signSnapshot,
  snapshotHash,
  snapshotSigningInput,
  verifySnapshot,
} from './snapshot.js';
export { verifyEvidence, fetchWithLimits } from './evidence.js';
export type { EvidenceBody, EvidenceOptions, EvidenceResult } from './evidence.js';
export {
  INDEX_SNAPSHOT_TYPE,
  IndexerError,
} from './types.js';
export type {
  DetachedSignature,
  EvidenceScores,
  EvidenceTier,
  IndexSnapshot,
  IndexerOptions,
  ReceiptRecord,
  ReceiptScore,
  ReceiptSummary,
  SnapshotBundle,
  SnapshotVerifyResult,
  SubjectView,
  SubmitResult,
  Weights,
} from './types.js';
