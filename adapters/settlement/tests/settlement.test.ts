/**
 * M6 acceptance tests (docs/module-cards/M6-settlement.md):
 * 1. both paths walk AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING,
 *    every event verifyFile === 'valid', state machine transitions succeed;
 * 2. face-value mismatch ("3200.00" vs "3200.0") rejects at confirm;
 * 3. test-voucher double redemption of the same code rejects;
 * 4. no secret-like fields anywhere in persisted objects/events;
 * 5. `vitest run` green + `tsc -b` clean (enforced by the build step).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFile } from '@agent-trade/signed-files';
import { openStore } from '@agent-trade/local-store';
import type { Store } from '@agent-trade/local-store';

import {
  createManualSettlementAdapter,
  createTestVoucherAdapter,
  markFulfilling,
  DEFAULT_TEST_VOUCHER_ISSUER,
} from '../src/index.js';
import type { SignedFile } from '@agent-trade/signed-files';
import {
  MemoryTaskStore,
  dealSigned,
  findSecretKeys,
  makeAgent,
  makeDeal,
  makeResolver,
  scanStoreForSecrets,
  tradeIdOf,
} from './helpers.js';
import type { Agent } from './helpers.js';
import { UUIDV7_RE } from '../src/uuid.js';

let dir: string;
let store: Store;
let buyer: Agent;
let seller: Agent;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settlement-'));
  store = openStore(dir);
  buyer = makeAgent('buyer@example.test');
  seller = makeAgent('seller@example.test');
  store.saveKey(buyer.agentId, buyer.secretKey);
  store.saveKey(seller.agentId, seller.secretKey);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const buyerCtx = () => ({ store, agentId: buyer.agentId, secretKey: buyer.secretKey });
const sellerCtx = () => ({ store, agentId: seller.agentId, secretKey: seller.secretKey });

/** Persist a schema-valid DEAL and land the trade in AGREED. */
function agreedDeal(params: { amount?: string; method?: string } = {}): SignedFile {
  const deal = makeDeal({ buyer, seller, ...params });
  store.putObject(deal); // throws unless verifyFile === 'valid'
  store.applyEvent(tradeIdOf(deal), dealSigned(deal, buyer));
  expect(store.stateOf(tradeIdOf(deal))).toBe('AGREED');
  return deal;
}

const VOUCHER_ID_RE = /^TEST-VOUCHER-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('M6 acceptance 1a: test-voucher walks AGREED → … → FULFILLING, all events valid', () => {
  it('request → confirm → markFulfilling, every event verifyFile valid and state machine advances', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const tradeId = tradeIdOf(deal);
    const adapter = createTestVoucherAdapter();

    const requested = await adapter.request(deal, buyerCtx());
    expect(verifyFile(requested, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('PAYMENT_PENDING');

    const body = requested.body as { event_type: string; actor: string; event_id: string; evidence: Record<string, unknown> };
    expect(body.event_type).toBe('PAYMENT_REQUESTED');
    expect(body.actor).toBe(buyer.agentId);
    expect(body.event_id).toMatch(UUIDV7_RE);
    // evidence: method / executor ref / voucher id only (card rule)
    expect(Object.keys(body.evidence).sort()).toEqual(['executor_ref', 'method', 'voucher_id']);
    expect(body.evidence.method).toBe('test-voucher');
    expect(body.evidence.executor_ref).toBe(DEFAULT_TEST_VOUCHER_ISSUER);
    expect(body.evidence.voucher_id).toMatch(VOUCHER_ID_RE);

    const confirmed = await adapter.confirm(deal, sellerCtx());
    expect(verifyFile(confirmed, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
    const cbody = confirmed.body as { event_type: string; actor: string; evidence: Record<string, unknown> };
    expect(cbody.event_type).toBe('PAYMENT_CONFIRMED');
    expect(cbody.actor).toBe(seller.agentId);
    expect(cbody.evidence.voucher_id).toBe(body.evidence.voucher_id); // same credential

    const fulfilling = await markFulfilling(deal, sellerCtx(), { method: 'test-voucher' });
    expect(verifyFile(fulfilling, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('FULFILLING');
    const fbody = fulfilling.body as { event_type: string; actor: string; evidence: Record<string, unknown> };
    expect(fbody.event_type).toBe('FULFILLING');
    expect(fbody.actor).toBe(seller.agentId);
    expect(fbody.evidence.method).toBe('test-voucher');
    expect(fbody.evidence.executor_ref).toBe(seller.agentId);

    // the returned events must also round-trip through the store's own verifier
    expect(store.putObject(requested)).toBeTruthy();
    expect(store.putObject(confirmed)).toBeTruthy();
    expect(store.putObject(fulfilling)).toBeTruthy();
  });

  it('request on a trade that is not AGREED is rejected (state machine enforced)', async () => {
    const deal = makeDeal({ buyer, seller, amount: '3200.00' });
    const adapter = createTestVoucherAdapter();
    await expect(adapter.request(deal, buyerCtx())).rejects.toThrow(/PAYMENT_REQUESTED/);
    expect(store.stateOf(tradeIdOf(deal))).toBeUndefined();
  });

  it('markFulfilling before PAYMENT_CONFIRMED is rejected', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const adapter = createTestVoucherAdapter();
    await adapter.request(deal, buyerCtx()); // PAYMENT_PENDING
    await expect(markFulfilling(deal, sellerCtx())).rejects.toThrow(/FULFILLING/);
    expect(store.stateOf(tradeIdOf(deal))).toBe('PAYMENT_PENDING');
  });
});

describe('M6 acceptance 1b: manual-settlement walks AGREED → … → FULFILLING, all events valid', () => {
  it('request creates a PAY task; confirm after human completion; markFulfilling', async () => {
    const deal = agreedDeal({ amount: '3200.00', method: 'manual-settlement' });
    const tradeId = tradeIdOf(deal);
    const tasks = new MemoryTaskStore();
    const adapter = createManualSettlementAdapter({ taskStore: tasks });

    const requested = await adapter.request(deal, buyerCtx());
    expect(verifyFile(requested, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('PAYMENT_PENDING');

    const body = requested.body as { event_type: string; actor: string; evidence: Record<string, unknown> };
    expect(body.event_type).toBe('PAYMENT_REQUESTED');
    expect(body.actor).toBe(buyer.agentId);
    expect(Object.keys(body.evidence).sort()).toEqual(['method', 'task_id']);
    expect(body.evidence.method).toBe('manual-settlement');

    // a PAY task was created in the injected task store
    const [task] = tasks.list({ tradeId });
    expect(task).toBeDefined();
    expect(task!.task_type).toBe('PAY');
    expect(task!.status).toBe('PENDING');
    expect(task!.instructions).toContain(tradeId);
    expect(task!.instructions).toContain('3200.00');
    expect(body.evidence.task_id).toBe(task!.task_id);
    expect(task!.task_id).toMatch(UUIDV7_RE);

    // human has not completed yet → confirm must refuse
    await expect(adapter.confirm(deal, sellerCtx())).rejects.toThrow(/expected DONE/);
    expect(store.stateOf(tradeId)).toBe('PAYMENT_PENDING');

    // human completes the payment task, then the model signs PAYMENT_CONFIRMED
    tasks.complete(task!.task_id, { payment_reference: 'txn-0001' });
    expect(tasks.get(task!.task_id)!.status).toBe('DONE');

    const confirmed = await adapter.confirm(deal, sellerCtx());
    expect(verifyFile(confirmed, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
    const cbody = confirmed.body as { event_type: string; actor: string; evidence: Record<string, unknown> };
    expect(cbody.event_type).toBe('PAYMENT_CONFIRMED');
    expect(cbody.actor).toBe(seller.agentId);
    expect(cbody.evidence.task_id).toBe(task!.task_id);
    expect(Object.keys(cbody.evidence).sort()).toEqual(['executor_ref', 'method', 'task_id']);

    const fulfilling = await markFulfilling(deal, sellerCtx());
    expect(verifyFile(fulfilling, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('FULFILLING');
  });

  it('confirm without a prior request is rejected', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const adapter = createManualSettlementAdapter({ taskStore: new MemoryTaskStore() });
    await expect(adapter.confirm(deal, sellerCtx())).rejects.toThrow(/no PAY task/);
  });
});

describe('M6 acceptance 2: face-value mismatch rejects at confirm', () => {
  it('"3200.00" voucher cannot be redeemed against a "3200.0" deal (character-exact)', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const tradeId = tradeIdOf(deal);
    const adapter = createTestVoucherAdapter();
    await adapter.request(deal, buyerCtx());

    // a different deal object for the same trade with a different amount string
    const dealB = makeDeal({ tradeId, buyer, seller, amount: '3200.0' });
    await expect(adapter.confirm(dealB, sellerCtx())).rejects.toThrow(/does not exactly match/);
    expect(store.stateOf(tradeId)).toBe('PAYMENT_PENDING'); // unchanged

    // the correct deal still redeems afterwards
    const confirmed = await adapter.confirm(deal, sellerCtx());
    expect(verifyFile(confirmed, makeResolver(store))).toBe('valid');
    expect(store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
  });

  it('request refuses a deal without settlement.amount', async () => {
    const deal = agreedDeal({}); // amount omitted
    const adapter = createTestVoucherAdapter();
    await expect(adapter.request(deal, buyerCtx())).rejects.toThrow(/settlement\.amount is required/);
    expect(store.stateOf(tradeIdOf(deal))).toBe('AGREED');
  });

  it('request refuses a malformed amount string (defensive guard, before any event)', async () => {
    // A non-decimal amount is schema-invalid, so it can never pass
    // store.putObject; the adapter guard is defensive against unverified
    // deals, so hand the malformed deal straight to request.
    const deal = makeDeal({ buyer, seller, amount: '12abc' });
    const adapter = createTestVoucherAdapter();
    await expect(adapter.request(deal, buyerCtx())).rejects.toThrow(/not a decimal fixed-point/);
    expect(store.stateOf(tradeIdOf(deal))).toBeUndefined(); // nothing persisted
  });
});

describe('M6 acceptance 3: test-voucher double redemption is rejected', () => {
  it('redeeming the same voucher code twice throws and leaves state unchanged', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const tradeId = tradeIdOf(deal);
    const adapter = createTestVoucherAdapter();
    await adapter.request(deal, buyerCtx());
    await adapter.confirm(deal, sellerCtx());
    expect(store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');

    await expect(adapter.confirm(deal, sellerCtx())).rejects.toThrow(/already redeemed/);
    expect(store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED'); // no regression
  });

  it('a second request for the same trade is rejected by the state machine (single voucher per trade)', async () => {
    const deal = agreedDeal({ amount: '3200.00' });
    const adapter = createTestVoucherAdapter();
    await adapter.request(deal, buyerCtx());
    await expect(adapter.request(deal, buyerCtx())).rejects.toThrow(/PAYMENT_REQUESTED/);
    expect(store.stateOf(tradeIdOf(deal))).toBe('PAYMENT_PENDING');
  });
});

describe('M6 acceptance 4: no secret-like fields in any persisted object/event', () => {
  it('walks both settlement paths and scans every fact file + index.sqlite', async () => {
    // trade 1 — test-voucher full chain
    const dealV = agreedDeal({ amount: '3200.00' });
    const tv = createTestVoucherAdapter();
    await tv.request(dealV, buyerCtx());
    await tv.confirm(dealV, sellerCtx());
    await markFulfilling(dealV, sellerCtx());

    // trade 2 — manual-settlement full chain
    const dealM = agreedDeal({ amount: '150.50', method: 'manual-settlement' });
    const tasks = new MemoryTaskStore();
    const ms = createManualSettlementAdapter({ taskStore: tasks });
    const req = await ms.request(dealM, buyerCtx());
    const taskId = (req.body as { evidence: { task_id: string } }).evidence.task_id;
    tasks.complete(taskId, { payment_reference: 'txn-0002' });
    await ms.confirm(dealM, sellerCtx());
    await markFulfilling(dealM, sellerCtx());

    // the produced events themselves must be secret-clean too
    for (const file of [dealV, dealM]) expect(findSecretKeys(file)).toEqual([]);

    // every fact file and the sqlite index contain no secret-like names
    const violations = scanStoreForSecrets(dir);
    expect(violations).toEqual([]);
  });

  it('evidence of every produced event contains only method/executor_ref/credential-id', async () => {
    const dealV = agreedDeal({ amount: '3200.00' });
    const tv = createTestVoucherAdapter();
    const ev1 = await tv.request(dealV, buyerCtx());
    const ev2 = await tv.confirm(dealV, sellerCtx());

    const dealM = agreedDeal({ amount: '9.99', method: 'manual-settlement' });
    const tasks = new MemoryTaskStore();
    const ms = createManualSettlementAdapter({ taskStore: tasks });
    const ev3 = await ms.request(dealM, buyerCtx());
    const taskId = (ev3.body as { evidence: { task_id: string } }).evidence.task_id;
    tasks.complete(taskId, { payment_reference: 'x' });
    const ev4 = await ms.confirm(dealM, sellerCtx());

    const allowed = new Set(['method', 'executor_ref', 'voucher_id', 'task_id']);
    for (const ev of [ev1, ev2, ev3, ev4]) {
      const evidence = (ev.body as { evidence: Record<string, unknown> }).evidence;
      const unexpected = Object.keys(evidence).filter((key) => !allowed.has(key));
      expect(unexpected, `unexpected evidence keys in ${(ev.body as { event_type: string }).event_type}`).toEqual([]);
      // no secret-like key names inside evidence
      expect(findSecretKeys(ev)).toEqual([]);
    }
  });
});
