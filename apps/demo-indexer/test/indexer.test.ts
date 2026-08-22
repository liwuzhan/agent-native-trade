/**
 * M8 acceptance 1 / 2 / 4 + intake/HTTP surface.
 *
 *  1. tampered receipts rejected; valid receipts indexed and queryable
 *  2. two instances with different weights.json score the same set differently
 *  4. evidence tiers: bundle-verified → high tier; unreachable deal_ref →
 *     tier score 0 but receipt still indexed at the low tier
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { serialize } from '@agent-trade/signed-files';

import { Indexer } from '../src/indexer.js';
import { verifySnapshot } from '../src/snapshot.js';
import { startIndexerServer } from '../src/server.js';
import { IndexerError } from '../src/types.js';
import {
  altWeights,
  dealObjectId,
  defaultWeights,
  loadVectors,
  makeDeal,
  makeReceipt,
  rmDir,
  vec,
} from './helpers.js';

const vectors = loadVectors();
const buyerSeed = vectors.identities.agent_buyer!.seed;
const sellerSeed = vectors.identities.agent_seller!.seed;
const validVectorReceipt = vec('trade-receipt-valid').file;

function newIndexer(dir: string, weights = defaultWeights()) {
  const indexer = new Indexer({ dir, weights, indexerId: 'demo-indexer' });
  indexer.addTrusted('agent_buyer', buyerSeed);
  indexer.addTrusted('agent_seller', sellerSeed);
  return indexer;
}

let dir: string;
let indexer: Indexer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'demo-indexer-'));
  indexer = newIndexer(dir);
});

afterEach(() => {
  indexer.close();
  rmDir(dir);
});

describe('acceptance 1: tampered receipts rejected, valid receipts indexed + queryable', () => {
  it('indexes the valid vector TRADE_RECEIPT and answers the subject view', async () => {
    const result = await indexer.submitReceipt(validVectorReceipt);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;

    // vector receipt: no bundle, deal_ref present but unreachable, settlement
    // event present, POSITIVE → default weights: 0 + 10 + 10 + 10 = 30
    expect(result.record.evidence_tier).toBe('none');
    expect(result.record.evidence_score).toBe(0);
    expect(result.record.score).toBe(30);

    const view = indexer.subjectView('agent_seller');
    expect(view).toBeDefined();
    expect(view!.receipt_count).toBe(1);
    expect(view!.score).toBe(30);
    expect(view!.receipts[0]!.receipt_id).toBe((validVectorReceipt.body as { receipt_id: string }).receipt_id);
  });

  it('rejects a tampered body that keeps the original body_hash (M0 attack)', async () => {
    const tampered = structuredClone(validVectorReceipt);
    (tampered.body as { comment?: string }).comment = 'tampered!';
    // body_hash left untouched → ① body_hash mismatch
    await expect(indexer.submitReceipt(tampered)).rejects.toThrow(/fail:body_hash_mismatch/);
  });

  it('rejects a tampered body with a recomputed body_hash (signature invalid)', async () => {
    const tampered = structuredClone(validVectorReceipt);
    (tampered.body as { comment?: string }).comment = 'tampered!';
    const { jcs, sha256Hex } = await import('@agent-trade/identity');
    tampered.body_hash = 'sha256:' + sha256Hex(jcs(tampered.body));
    await expect(indexer.submitReceipt(tampered)).rejects.toThrow(/fail:signature_invalid/);
  });

  it('rejects the M0 tampered deal vector (deal-tampered-body-keep-hash)', async () => {
    await expect(indexer.submitReceipt(vec('deal-tampered-body-keep-hash').file)).rejects.toThrow(/fail:body_hash_mismatch/);
  });

  it('rejects a valid DEAL submitted to /receipts (receipts only)', async () => {
    const deal = vec('deal-valid').file;
    await expect(indexer.submitReceipt(deal)).rejects.toThrow(/expected TRADE_RECEIPT, got DEAL/);
  });

  it('rejects receipts signed by an untrusted agent', async () => {
    const { generateIdentity } = await import('@agent-trade/identity');
    const stranger = generateIdentity();
    const receipt = makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'stranger',
      secretKey: stranger.secretKey,
    });
    await expect(indexer.submitReceipt(receipt)).rejects.toThrow(/fail:unknown_signer/);
  });

  it('dedups by content hash and by receipt_id; flags receipt_id reuse conflicts', async () => {
    const first = await indexer.submitReceipt(validVectorReceipt);
    expect(first.status).toBe('indexed');
    if (first.status !== 'indexed') throw new Error('unreachable');

    const second = await indexer.submitReceipt(structuredClone(validVectorReceipt));
    expect(second.status).toBe('duplicate');
    if (second.status !== 'duplicate') throw new Error('unreachable');
    expect(second.object_id).toBe(first.object_id);
    expect(indexer.subjectView('agent_seller')!.receipt_count).toBe(1);

    // same receipt_id, different content → conflict
    const conflict = makeReceipt({
      receiptId: (validVectorReceipt.body as { receipt_id: string }).receipt_id,
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'NEGATIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
    });
    const res = await indexer.submitReceipt(conflict);
    expect(res.status).toBe('conflict');
  });
});

describe('acceptance 4: evidence tiers (bundle first, online fetch fallback, size cap)', () => {
  it('bundle verified → high tier (weights.scores.evidence.bundle)', async () => {
    const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
    const receipt = makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
      dealRef: { object_id: dealObjectId(deal), body_hash: deal.body_hash },
      settlementEventRef: 'sha256:' + 'a'.repeat(64),
      bundle: [deal],
    });
    const result = await indexer.submitReceipt(receipt);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.record.evidence_tier).toBe('bundle');
    expect(result.record.evidence_score).toBe(defaultWeights().scores.evidence.bundle);
    expect(result.record.score).toBe(40 + 10 + 10 + 10); // bundle + deal_ref + settlement + POSITIVE
  });

  it('invalid bundle (tampered entry) does not earn the bundle tier', async () => {
    const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
    const tampered = structuredClone(deal) as typeof deal;
    (tampered.body as { subject: { description: string } }).subject.description = 'tampered bundle';
    const receipt = makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
      bundle: [tampered],
    });
    const result = await indexer.submitReceipt(receipt);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.record.evidence_tier).not.toBe('bundle');
    expect(result.record.evidence_score).toBe(0); // no valid bundle, no deal_ref → none
  });

  it('unreachable deal_ref → evidence tier score 0, receipt still indexed at low tier', async () => {
    const receipt = makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
      dealRef: {
        object_id: 'sha256:' + 'b'.repeat(64),
        body_hash: 'sha256:' + 'c'.repeat(64),
        distribution_refs: ['http://127.0.0.1:9/unreachable.json'], // dead port → fast refusal
      },
    });
    const result = await indexer.submitReceipt(receipt);
    expect(result.status).toBe('indexed'); // accepted at the low tier
    if (result.status !== 'indexed') return;
    expect(result.record.evidence_tier).toBe('none');
    expect(result.record.evidence_score).toBe(0);
    expect(result.record.score).toBe(10); // deal_ref +10, missing settlement -10, POSITIVE +10
  });

  it('deal_ref resolved from the local fact store → referenced tier', async () => {
    const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
    indexer.storeFact(deal); // the referenced object already exists locally
    const receipt = makeReceipt({
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
      dealRef: { object_id: dealObjectId(deal), body_hash: deal.body_hash },
      settlementEventRef: 'sha256:' + 'a'.repeat(64),
    });
    const result = await indexer.submitReceipt(receipt);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.record.evidence_tier).toBe('referenced');
    expect(result.record.evidence_score).toBe(defaultWeights().scores.evidence.referenced);
    expect(result.record.score).toBe(20 + 10 + 10 + 10);
  });

  it('deal_ref fetched online (fallback) → referenced tier', async () => {
    const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(serialize(deal));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const receipt = makeReceipt({
        subject: 'agent_seller',
        direction: 'buyer_to_seller',
        result: 'COMPLETED',
        rating: 'POSITIVE',
        signer: 'agent_buyer',
        secretKey: buyerSeed,
        dealRef: {
          object_id: dealObjectId(deal),
          body_hash: deal.body_hash,
          distribution_refs: [`http://127.0.0.1:${port}/deal.json`],
        },
      });
      const result = await indexer.submitReceipt(receipt);
      expect(result.status).toBe('indexed');
      if (result.status !== 'indexed') return;
      expect(result.record.evidence_tier).toBe('referenced');
      expect(result.record.evidence_detail).toContain('fetched online');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('online fetch respects the size cap (over-cap payload → tier none)', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(64 * 1024) });
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const capped = new Indexer({ dir, weights: defaultWeights(), indexerId: 'demo-indexer', fetchMaxBytes: 1024 });
    capped.addTrusted('agent_buyer', buyerSeed);
    try {
      const receipt = makeReceipt({
        subject: 'agent_seller',
        direction: 'buyer_to_seller',
        result: 'COMPLETED',
        rating: 'POSITIVE',
        signer: 'agent_buyer',
        secretKey: buyerSeed,
        dealRef: {
          object_id: 'sha256:' + 'd'.repeat(64),
          body_hash: 'sha256:' + 'e'.repeat(64),
          distribution_refs: [`http://127.0.0.1:${port}/big.json`],
        },
      });
      const result = await capped.submitReceipt(receipt);
      expect(result.status).toBe('indexed');
      if (result.status !== 'indexed') return;
      expect(result.record.evidence_tier).toBe('none');
      expect(result.record.evidence_detail).toContain('over cap');
    } finally {
      capped.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('acceptance 2: two instances with different weights.json score differently', () => {
  it('same receipt set → different subject scores under weights.json vs weights-alt.json', async () => {
    const deal = makeDeal({ buyer: 'agent_buyer', seller: 'agent_seller', secretKey: buyerSeed });
    const receipts = [
      makeReceipt({
        subject: 'agent_seller',
        direction: 'buyer_to_seller',
        result: 'COMPLETED',
        rating: 'POSITIVE',
        signer: 'agent_buyer',
        secretKey: buyerSeed,
        dealRef: { object_id: dealObjectId(deal), body_hash: deal.body_hash },
        settlementEventRef: 'sha256:' + 'a'.repeat(64),
        bundle: [deal],
      }),
      makeReceipt({
        subject: 'agent_seller',
        direction: 'buyer_to_seller',
        result: 'COMPLETED',
        rating: 'NEUTRAL',
        signer: 'agent_buyer',
        secretKey: buyerSeed,
        dealRef: { object_id: dealObjectId(deal), body_hash: deal.body_hash },
        settlementEventRef: 'sha256:' + 'a'.repeat(64),
      }),
      makeReceipt({
        subject: 'agent_seller',
        direction: 'buyer_to_seller',
        result: 'DISPUTED',
        rating: 'NEGATIVE',
        signer: 'agent_buyer',
        secretKey: buyerSeed,
      }),
    ];

    const dirA = mkdtempSync(join(tmpdir(), 'idx-weights-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'idx-weights-b-'));
    const indexerA = newIndexer(dirA, defaultWeights());
    const indexerB = newIndexer(dirB, altWeights());
    try {
      // the referenced deal must exist locally in both instances
      indexerA.storeFact(deal);
      indexerB.storeFact(deal);
      for (const receipt of receipts) {
        await indexerA.submitReceipt(structuredClone(receipt));
        await indexerB.submitReceipt(structuredClone(receipt));
      }

      const viewA = indexerA.subjectView('agent_seller')!;
      const viewB = indexerB.subjectView('agent_seller')!;
      expect(viewA.receipt_count).toBe(3);
      expect(viewB.receipt_count).toBe(3);

      // per-receipt scores must differ too
      const scoresA = viewA.receipts.map((r) => r.score).sort((a, b) => a - b);
      const scoresB = viewB.receipts.map((r) => r.score).sort((a, b) => a - b);
      expect(scoresA).not.toEqual(scoresB);

      // aggregate must differ: 70+42-30=82 vs 80+35-15=100
      expect(viewA.score).toBe(82);
      expect(viewB.score).toBe(100);
      expect(viewA.score).not.toBe(viewB.score);

      // tiers are facts; only the pricing changes
      expect(viewA.receipts.map((r) => r.evidence_tier).sort()).toEqual(['bundle', 'none', 'referenced']);
      const bundleA = viewA.receipts.find((r) => r.evidence_tier === 'bundle')!;
      const bundleB = viewB.receipts.find((r) => r.evidence_tier === 'bundle')!;
      expect(bundleA.evidence_score).toBe(40);
      expect(bundleB.evidence_score).toBe(60);
    } finally {
      indexerA.close();
      indexerB.close();
      rmDir(dirA);
      rmDir(dirB);
    }
  });
});

describe('HTTP surface', () => {
  let http: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    http = await startIndexerServer(indexer, 0);
  });

  afterEach(async () => {
    await http.close();
  });

  it('POST /receipts accepts a valid receipt and GET /subjects/:agentId answers it', async () => {
    const res = await fetch(`http://127.0.0.1:${http.port}/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(validVectorReceipt),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; receipt: { score: number } };
    expect(body.status).toBe('indexed');
    expect(body.receipt.score).toBe(30);

    const viewRes = await fetch(`http://127.0.0.1:${http.port}/subjects/agent_seller`);
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as { agent_id: string; score: number };
    expect(view.agent_id).toBe('agent_seller');
    expect(view.score).toBe(30);
  });

  it('POST /receipts rejects a tampered receipt with 400', async () => {
    const tampered = structuredClone(validVectorReceipt);
    (tampered.body as { comment?: string }).comment = 'tampered!';
    const res = await fetch(`http://127.0.0.1:${http.port}/receipts`, {
      method: 'POST',
      body: serialize(tampered),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('verify_failed');
  });

  it('POST /receipts rejects non-JSON and non-envelope bodies with 400', async () => {
    const notJson = await fetch(`http://127.0.0.1:${http.port}/receipts`, { method: 'POST', body: 'not json{' });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toBe('invalid_json');

    const notEnvelope = await fetch(`http://127.0.0.1:${http.port}/receipts`, { method: 'POST', body: '[1,2,3]' });
    expect(notEnvelope.status).toBe(400);
    expect(((await notEnvelope.json()) as { error: string }).error).toBe('invalid_envelope');
  });

  it('POST duplicate → 200 duplicate; receipt_id conflict → 409', async () => {
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${http.port}/receipts`, { method: 'POST', body });

    const first = await post(serialize(validVectorReceipt));
    expect(first.status).toBe(201);
    const dup = await post(serialize(validVectorReceipt));
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { status: string }).status).toBe('duplicate');

    const conflict = makeReceipt({
      receiptId: (validVectorReceipt.body as { receipt_id: string }).receipt_id,
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'NEGATIVE',
      signer: 'agent_buyer',
      secretKey: buyerSeed,
    });
    const conflictRes = await post(serialize(conflict));
    expect(conflictRes.status).toBe(409);
  });

  it('GET /export returns a self-verifying signed snapshot', async () => {
    await indexer.submitReceipt(validVectorReceipt);
    const res = await fetch(`http://127.0.0.1:${http.port}/export`);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as { snapshot: Parameters<typeof verifySnapshot>[0]; signature: Parameters<typeof verifySnapshot>[1] };
    expect(bundle.snapshot.body.subjects[0]!.agent_id).toBe('agent_seller');
    expect(verifySnapshot(bundle.snapshot, bundle.signature)).toBe('valid');
  });
});
