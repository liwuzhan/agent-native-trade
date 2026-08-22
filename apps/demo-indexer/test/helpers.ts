/**
 * Test fixtures for demo-indexer (module M8).
 *
 * Vector identities/files come from the authoritative protocol test-vectors
 * (specification.md: "权威源：protocol/test-vectors/"). Runtime code never
 * reads repo-relative paths — only tests do.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addSignature, buildObject, objectId } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';
import { jcs, sha256Hex } from '@agent-trade/identity';
import { buildManifest, catalogHash } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';

import { loadWeights } from '../src/weights.js';
import type { EvidenceTier, Weights } from '../src/types.js';

export interface VectorIdentity {
  public_key: string;
  seed: string;
}

export interface VectorCase {
  name: string;
  object_type: SignedFile['object_type'];
  file: SignedFile;
  object_id?: string;
  expect: string;
  tamper?: string;
}

export interface Vectors {
  identities: Record<string, VectorIdentity>;
  cases: VectorCase[];
}

export function loadVectors(): Vectors {
  const url = new URL('../../../protocol/test-vectors/vectors.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Vectors;
}

export function vec(name: string): VectorCase {
  const found = loadVectors().cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`vector case not found: ${name}`);
  return found;
}

export function defaultWeights(): Weights {
  return loadWeights(new URL('../weights.json', import.meta.url).pathname);
}

export function altWeights(): Weights {
  return loadWeights(new URL('../weights-alt.json', import.meta.url).pathname);
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Deterministic RFC 8785 JCS of a value, hashed like protocol §2. */
export function hashOf(value: unknown): string {
  return 'sha256:' + sha256Hex(jcs(value));
}

/** Generate a UUID v7 (the DEAL schema requires the v7 version nibble). */
export function uuidV7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now()) & 0xffffffffffffn;
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface MakeDealParams {
  buyer: string;
  seller: string;
  secretKey: string;
  tradeId?: string;
  listingRef?: string;
}

/** Build a schema-valid DEAL signed by the buyer (used as evidence bundle content). */
export function makeDeal(params: MakeDealParams): SignedFile {
  const tradeId = params.tradeId ?? uuidV7();
  const body = {
    trade_id: tradeId,
    buyer: params.buyer,
    seller: params.seller,
    subject: {
      listing_ref: params.listingRef ?? `listing-${tradeId}`,
      description: 'demo deal',
      quantity: 1,
      acceptance_conditions: ['delivered as described'],
    },
    settlement: { asset: 'iso4217:CNY', amount: '100.00', method: 'escrow' },
    fulfillment: {
      deadline: '2026-12-31T00:00:00Z',
      destination_ref: 'warehouse-1',
      carrier_ref: 'carrier-demo',
    },
  };
  return addSignature(buildObject('DEAL', body), params.buyer, params.secretKey);
}

export interface MakeReceiptParams {
  receiptId?: string;
  tradeId?: string;
  contractHash?: string;
  subject: string;
  direction: 'buyer_to_seller' | 'seller_to_buyer' | 'third_party';
  result: 'COMPLETED' | 'DISPUTED' | 'RESOLVED' | 'CANCELLED';
  rating: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'FACT_ONLY';
  signer: string;
  secretKey: string;
  comment?: string;
  dealRef?: { object_id?: string; body_hash?: string; distribution_refs?: string[] } | null;
  settlementEventRef?: string;
  bundle?: SignedFile[];
  issuedAt?: string;
}

/** Build a schema-valid TRADE_RECEIPT signed by `signer`. */
export function makeReceipt(params: MakeReceiptParams): SignedFile {
  const body: Record<string, unknown> = {
    receipt_id: params.receiptId ?? uuidV7(),
    trade_id: params.tradeId ?? uuidV7(),
    contract_hash: params.contractHash ?? hashOf({ demo: 'contract' }),
    subject: params.subject,
    direction: params.direction,
    result: params.result,
    rating: params.rating,
  };
  if (params.comment !== undefined) body.comment = params.comment;
  if (params.dealRef !== undefined || params.settlementEventRef !== undefined || params.bundle !== undefined) {
    const evidence: Record<string, unknown> = {};
    if (params.dealRef !== undefined && params.dealRef !== null) evidence.deal_ref = params.dealRef;
    if (params.settlementEventRef !== undefined) evidence.settlement_event_ref = params.settlementEventRef;
    if (params.bundle !== undefined) evidence.bundle = params.bundle;
    body.evidence = evidence;
  }
  return addSignature(buildObject('TRADE_RECEIPT', body), params.signer, params.secretKey, params.issuedAt);
}

export interface CatalogFixture {
  hash: string;
  manifest: Manifest;
  rawBody: string;
  files: { path: string; content: string; data: Uint8Array }[];
}

/** Build a catalog archive body ({ manifest, files: [{path, content: base64}] }). */
export function makeCatalogFixture(entries: { path: string; data: Uint8Array }[]): CatalogFixture {
  const manifest = buildManifest(entries);
  const hash = catalogHash(manifest);
  const files = entries.map((e) => ({ path: e.path, content: Buffer.from(e.data).toString('base64'), data: e.data }));
  return { hash, manifest, files, rawBody: JSON.stringify({ manifest, files }) };
}

export function dealObjectId(deal: SignedFile): string {
  return objectId(deal);
}

export type { EvidenceTier };
