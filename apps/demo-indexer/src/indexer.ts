/**
 * demo-indexer core (module M8): receipt intake, dedup, evidence verification,
 * weighted scoring, subject aggregation, signed static snapshot export and
 * catalog archive mirror.
 *
 * Storage: local-store (M3) owns the fact files (.data/objects/…) and the
 * trust ring (.data/keys/…); this module owns a small receipts/catalogs index
 * in its own SQLite file (.data/receipts.sqlite). Fact files are the source of
 * truth; the SQLite index is disposable and re-derivable.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { publicKeyFromSeed, generateIdentity } from '@agent-trade/identity';
import { openStore } from '@agent-trade/local-store';
import type { Store } from '@agent-trade/local-store';
import { catalogHash, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';
import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import { verifyEvidence } from './evidence.js';
import { buildSnapshot, signSnapshot } from './snapshot.js';
import type {
  EvidenceTier,
  IndexerOptions,
  ReceiptRecord,
  ReceiptScore,
  ReceiptSummary,
  SnapshotBundle,
  SubjectView,
  SubmitResult,
  Weights,
} from './types.js';
import { IndexerError } from './types.js';
import { priceReceipt } from './weights.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

interface ReceiptRow {
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
  has_deal_ref: number;
  has_settlement_event: number;
  evidence_tier: string;
  evidence_detail: string;
  indexed_at: string;
}

interface CatalogRow {
  catalog_hash: string;
  raw_body: string;
  stored_at: string;
}

interface ReceiptBody {
  receipt_id: string;
  trade_id: string;
  contract_hash: string;
  subject: string;
  direction: string;
  result: string;
  rating: string;
  comment?: string;
  evidence?: {
    deal_ref?: { object_id?: string; body_hash?: string } | null;
    settlement_event_ref?: string;
    bundle?: unknown;
  };
}

function rowToRecord(row: ReceiptRow): ReceiptRecord {
  return {
    receipt_id: row.receipt_id,
    object_id: row.object_id,
    body_hash: row.body_hash,
    subject: row.subject,
    direction: row.direction,
    result: row.result,
    rating: row.rating,
    issuer: row.issuer,
    issued_at: row.issued_at,
    comment: row.comment,
    has_deal_ref: row.has_deal_ref === 1,
    has_settlement_event: row.has_settlement_event === 1,
    evidence_tier: row.evidence_tier as EvidenceTier,
    evidence_detail: row.evidence_detail,
    indexed_at: row.indexed_at,
  };
}

/** Build the trust ring the same way local-store does (reads .data/keys). */
function loadKeyRingFromDisk(dir: string): Map<string, string> {
  const ring = new Map<string, string>();
  const keysDir = join(dir, '.data', 'keys');
  let names: string[] = [];
  try {
    names = readdirSync(keysDir);
  } catch {
    return ring; // no keys yet
  }
  for (const name of names) {
    if (!name.endsWith('.key')) continue;
    const agentId = decodeURIComponent(name.slice(0, -'.key'.length));
    const seed = readFileSync(join(keysDir, name), 'utf8').trim();
    ring.set(agentId, publicKeyFromSeed(seed));
  }
  return ring;
}

export class Indexer {
  readonly dir: string;
  readonly indexerId: string;
  readonly indexerPublicKey: string;
  private readonly store: Store;
  private readonly db: Database.Database;
  private readonly keyRing: Map<string, string>;
  private weights: Weights;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchTimeoutMs: number;
  private readonly fetchMaxBytes: number;

  constructor(options: IndexerOptions) {
    this.dir = options.dir;
    this.indexerId = options.indexerId ?? 'demo-indexer';
    this.weights = options.weights;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 2000;
    this.fetchMaxBytes = options.fetchMaxBytes ?? 256 * 1024;

    mkdirSync(join(this.dir, '.data'), { recursive: true });
    this.store = openStore(this.dir);
    this.keyRing = loadKeyRingFromDisk(this.dir);

    // Site identity: generate + persist a fresh keypair on first open.
    const existingSeed = this.store.getKey(this.indexerId);
    if (existingSeed === undefined) {
      const identity = generateIdentity();
      this.store.saveKey(this.indexerId, identity.secretKey);
      this.keyRing.set(this.indexerId, identity.publicKey);
    }
    const sitePublicKey = this.keyRing.get(this.indexerId);
    if (sitePublicKey === undefined) {
      throw new Error(`indexer: site identity ${JSON.stringify(this.indexerId)} missing from keyring`);
    }
    this.indexerPublicKey = sitePublicKey;

    this.db = new Database(join(this.dir, '.data', 'receipts.sqlite'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id          TEXT PRIMARY KEY,
        object_id           TEXT NOT NULL UNIQUE,
        body_hash           TEXT NOT NULL UNIQUE,
        subject             TEXT NOT NULL,
        direction           TEXT NOT NULL,
        result              TEXT NOT NULL,
        rating              TEXT NOT NULL,
        issuer              TEXT NOT NULL,
        issued_at           TEXT NOT NULL,
        comment             TEXT,
        has_deal_ref        INTEGER NOT NULL,
        has_settlement_event INTEGER NOT NULL,
        evidence_tier       TEXT NOT NULL,
        evidence_detail     TEXT NOT NULL,
        indexed_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_by_subject ON receipts(subject);
      CREATE TABLE IF NOT EXISTS catalogs (
        catalog_hash TEXT PRIMARY KEY,
        raw_body     TEXT NOT NULL,
        stored_at    TEXT NOT NULL
      );
    `);
  }

  get currentWeights(): Weights {
    return this.weights;
  }

  /** Trust an agent's public key (persisted via local-store; receipts signed
   *  by unknown agents are rejected by verifyFile). */
  addTrusted(agentId: string, secretKey: string): void {
    this.store.saveKey(agentId, secretKey);
    this.keyRing.set(agentId, publicKeyFromSeed(secretKey));
  }

  private resolveKey = (signer: string): string | undefined => this.keyRing.get(signer);

  /** Primary key storage for signed fact files (bypasses receipt-specific
   *  rules; used by tests to place referenced deals in the local store). */
  storeFact(file: SignedFile): string {
    return this.store.putObject(file);
  }

  /** Read a stored fact file by object_id. */
  getFact(objectIdValue: string): SignedFile | undefined {
    return this.store.getObject(objectIdValue);
  }

  private rowByBodyHash(bodyHash: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM receipts WHERE body_hash = ?').get(bodyHash) as ReceiptRow | undefined;
  }

  private rowByReceiptId(receiptId: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId) as ReceiptRow | undefined;
  }

  private scoreRecord(row: ReceiptRow): ReceiptScore {
    const { evidence_score, score } = priceReceipt(
      {
        evidence_tier: row.evidence_tier as EvidenceTier,
        has_deal_ref: row.has_deal_ref === 1,
        has_settlement_event: row.has_settlement_event === 1,
        rating: row.rating,
      },
      this.weights,
    );
    return { ...rowToRecord(row), evidence_score, score };
  }

  /** Intake pipeline: verifyFile → dedup (receipt_id + content hash) → evidence
   *  verification (bundle first, online fetch fallback) → persist. */
  async submitReceipt(file: SignedFile): Promise<SubmitResult> {
    const result = verifyFile(file, this.resolveKey);
    if (result !== 'valid') {
      throw new IndexerError(`verify_failed:${result}`, `receipt rejected by verifyFile (${result})`);
    }
    if (file.object_type !== 'TRADE_RECEIPT') {
      throw new IndexerError('wrong_object_type', `expected TRADE_RECEIPT, got ${file.object_type}`);
    }
    const body = file.body as ReceiptBody;
    if (typeof body.receipt_id !== 'string' || typeof body.subject !== 'string') {
      throw new IndexerError('malformed_body', 'receipt body missing receipt_id/subject');
    }

    const objectIdValue = objectId(file);
    const bodyHash = file.body_hash;

    // Dedup by content hash first (identical content, whatever receipt_id).
    const byHash = this.rowByBodyHash(bodyHash);
    if (byHash !== undefined) {
      return { status: 'duplicate', record: this.scoreRecord(byHash), object_id: byHash.object_id };
    }
    // Dedup / conflict by receipt_id.
    const byId = this.rowByReceiptId(body.receipt_id);
    if (byId !== undefined) {
      if (byId.body_hash !== bodyHash) {
        return {
          status: 'conflict',
          reason: `receipt_id ${JSON.stringify(body.receipt_id)} already indexed with different content`,
        };
      }
      return { status: 'duplicate', record: this.scoreRecord(byId), object_id: byId.object_id };
    }

    // Evidence verification: bundle first, online fetch fallback.
    const evidenceResult = await verifyEvidence({
      evidence: body.evidence,
      resolveKey: this.resolveKey,
      getLocalObject: (id) => this.store.getObject(id),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.fetchTimeoutMs,
      maxBytes: this.fetchMaxBytes,
    });

    const hasDealRef =
      body.evidence?.deal_ref != null &&
      typeof body.evidence.deal_ref === 'object' &&
      typeof body.evidence.deal_ref.object_id === 'string' &&
      typeof body.evidence.deal_ref.body_hash === 'string';
    const hasSettlementEvent =
      typeof body.evidence?.settlement_event_ref === 'string' && body.evidence.settlement_event_ref.length > 0;

    const { evidence_score, score } = priceReceipt(
      {
        evidence_tier: evidenceResult.tier,
        has_deal_ref: hasDealRef,
        has_settlement_event: hasSettlementEvent,
        rating: body.rating,
      },
      this.weights,
    );

    // Persist: fact file first (source of truth, re-verified by the store),
    // then the index row.
    this.store.putObject(file);
    const indexedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO receipts
           (receipt_id, object_id, body_hash, subject, direction, result, rating,
            issuer, issued_at, comment, has_deal_ref, has_settlement_event,
            evidence_tier, evidence_detail, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.receipt_id,
        objectIdValue,
        bodyHash,
        body.subject,
        body.direction,
        body.result,
        body.rating,
        file.signatures[0]?.signer ?? '',
        file.signatures[0]?.issued_at ?? '',
        body.comment ?? null,
        hasDealRef ? 1 : 0,
        hasSettlementEvent ? 1 : 0,
        evidenceResult.tier,
        evidenceResult.detail,
        indexedAt,
      );

    const row = this.rowByReceiptId(body.receipt_id)!;
    return { status: 'indexed', record: this.scoreRecord(row), object_id: objectIdValue };
  }

  /** Aggregate view for one subject, priced with the current weights. */
  subjectView(agentId: string): SubjectView | undefined {
    const rows = this.db
      .prepare('SELECT * FROM receipts WHERE subject = ? ORDER BY issued_at, receipt_id')
      .all(agentId) as ReceiptRow[];
    if (rows.length === 0) return undefined;
    const priced = rows.map((row) => this.scoreRecord(row));
    const counts = { positive: 0, neutral: 0, negative: 0, fact_only: 0 };
    for (const row of rows) {
      if (row.rating === 'POSITIVE') counts.positive += 1;
      else if (row.rating === 'NEUTRAL') counts.neutral += 1;
      else if (row.rating === 'NEGATIVE') counts.negative += 1;
      else counts.fact_only += 1;
    }
    const receipts: ReceiptSummary[] = priced.map((r) => ({
      receipt_id: r.receipt_id,
      object_id: r.object_id,
      subject: r.subject,
      direction: r.direction,
      result: r.result,
      rating: r.rating,
      issuer: r.issuer,
      issued_at: r.issued_at,
      comment: r.comment,
      evidence_tier: r.evidence_tier,
      evidence_score: r.evidence_score,
      score: r.score,
    }));
    return {
      agent_id: agentId,
      score: priced.reduce((sum, r) => sum + r.score, 0),
      receipt_count: rows.length,
      positive: counts.positive,
      neutral: counts.neutral,
      negative: counts.negative,
      fact_only: counts.fact_only,
      receipts,
    };
  }

  /** All subject views, sorted by agent_id (deterministic snapshot content). */
  allSubjects(): SubjectView[] {
    const agents = this.db
      .prepare('SELECT DISTINCT subject FROM receipts ORDER BY subject')
      .all() as { subject: string }[];
    return agents
      .map((a) => this.subjectView(a.subject))
      .filter((v): v is SubjectView => v !== undefined);
  }

  /** Build + sign the static snapshot (aggregation + snapshot hash + site signature). */
  exportSnapshot(generatedAt?: string): SnapshotBundle {
    const snapshot = buildSnapshot({
      indexerId: this.indexerId,
      indexerPublicKey: this.indexerPublicKey,
      weights: this.weights,
      subjects: this.allSubjects(),
      generatedAt,
    });
    const seed = this.store.getKey(this.indexerId);
    if (seed === undefined) {
      throw new Error(`indexer: site secret key for ${JSON.stringify(this.indexerId)} missing`);
    }
    const signature = signSnapshot(snapshot, this.indexerId, seed);
    return { snapshot, signature };
  }

  /** Catalog archive mirror: validate manifest + hash, then store raw bytes. */
  storeCatalog(catalogHashValue: string, rawBody: string): void {
    if (!HASH_RE.test(catalogHashValue)) {
      throw new IndexerError('invalid_catalog_hash', `catalog hash must be "sha256:" + 64 lowercase hex, got ${JSON.stringify(catalogHashValue)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (err) {
      throw new IndexerError('invalid_json', `catalog body is not valid JSON (${(err as Error).message})`);
    }
    const obj = parsed as { manifest?: unknown; files?: unknown };
    if (typeof obj !== 'object' || obj === null || obj.manifest === undefined || !Array.isArray(obj.files)) {
      throw new IndexerError('malformed_catalog', 'catalog body must be { manifest, files: [{ path, content(base64) }] }');
    }
    const manifest = obj.manifest as Manifest;
    const files = (obj.files as { path?: unknown; content?: unknown }[]).map((f) => ({
      path: typeof f?.path === 'string' ? f.path : '',
      data: Uint8Array.from(Buffer.from(typeof f?.content === 'string' ? f.content : '', 'base64')),
    }));

    // Verify catalog_hash against the manifest, then every file against the manifest.
    let manifestHash: string;
    try {
      manifestHash = catalogHash(manifest);
    } catch (err) {
      throw new IndexerError('invalid_manifest', `manifest invalid (${(err as Error).message})`);
    }
    if (manifestHash !== catalogHashValue) {
      throw new IndexerError(
        'catalog_hash_mismatch',
        `catalog_hash ${JSON.stringify(catalogHashValue)} does not match manifest (${manifestHash})`,
      );
    }
    if (!verifyCatalogFiles(files, manifest)) {
      throw new IndexerError('manifest_verification_failed', 'files do not match the manifest (missing/mismatched content)');
    }

    this.db
      .prepare('INSERT INTO catalogs (catalog_hash, raw_body, stored_at) VALUES (?, ?, ?) ON CONFLICT(catalog_hash) DO UPDATE SET raw_body = excluded.raw_body, stored_at = excluded.stored_at')
      .run(catalogHashValue, rawBody, new Date().toISOString());
  }

  /** Fetch a stored catalog archive; the raw body round-trips byte-identically. */
  getCatalog(catalogHashValue: string): string | undefined {
    const row = this.db.prepare('SELECT raw_body FROM catalogs WHERE catalog_hash = ?').get(catalogHashValue) as
      | Pick<CatalogRow, 'raw_body'>
      | undefined;
    return row?.raw_body;
  }

  close(): void {
    this.store.close();
    this.db.close();
  }
}
