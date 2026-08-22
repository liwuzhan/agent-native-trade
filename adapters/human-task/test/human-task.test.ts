import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { objectId, verifyFile } from '@agent-trade/signed-files';
import { openStore } from '@agent-trade/local-store';
import { generateIdentity } from '@agent-trade/identity';

import { createHumanTaskStore, uuidv7 } from '../src/index.js';
import { UUIDV7_RE } from '../src/uuid.js';
import { makeDeal, makeEvent, resolveFrom, setup } from './helpers.js';
import type { Harness } from './helpers.js';

let h: Harness;

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
});

const taskFile = (taskId: string) => join(h.dir, '.data', 'tasks', taskId + '.json');

/** Advance a trade to PAYMENT_PENDING (DEAL_SIGNED → AGREED, PAYMENT_REQUESTED → PAYMENT_PENDING). */
function advanceToPending(tradeId: string): void {
  h.store.applyEvent(tradeId, makeEvent({ tradeId, eventType: 'DEAL_SIGNED', actor: 'agent_buyer', secretKey: h.buyer.secretKey }));
  h.store.applyEvent(tradeId, makeEvent({ tradeId, eventType: 'PAYMENT_REQUESTED', actor: 'agent_buyer', secretKey: h.buyer.secretKey }));
}

/** Create + complete a PAY task for the given trade. */
function donePayTask(tradeId: string, result: Record<string, unknown> = { confirmation: 'manual-transfer-2026-0001' }): string {
  const taskId = h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'Transfer 100.00 USD via manual settlement and report the reference.' });
  h.tasks.complete(taskId, result);
  return taskId;
}

function countMirrorRows(dir: string): number {
  const db = new DatabaseSync(join(dir, '.data', 'index.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('M7 acceptance 1: CRUD + status transitions', () => {
  it('create returns a uuid v7, persists .data/tasks/<id>.json, and get() round-trips it', () => {
    const tradeId = uuidv7();
    const taskId = h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'pay the seller' });

    expect(taskId).toMatch(UUIDV7_RE);
    expect(h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'again' })).not.toBe(taskId);

    const task = h.tasks.get(taskId);
    expect(task).toEqual({
      task_id: taskId,
      trade_id: tradeId,
      task_type: 'PAY',
      instructions: 'pay the seller',
      status: 'PENDING',
    });

    // task file is on disk in the M3 layout extension
    const onDisk = JSON.parse(readFileSync(taskFile(taskId), 'utf8'));
    expect(onDisk).toEqual(task);
    expect(onDisk.result).toBeUndefined(); // PENDING tasks carry no result
  });

  it('persists optional deadline and required_output', () => {
    const tradeId = uuidv7();
    const taskId = h.tasks.create({
      trade_id: tradeId,
      task_type: 'INSPECT',
      instructions: 'inspect the batch',
      deadline: '2026-09-01T00:00:00Z',
      required_output: ['photo', 'count'],
    });
    expect(h.tasks.get(taskId)).toMatchObject({
      deadline: '2026-09-01T00:00:00Z',
      required_output: ['photo', 'count'],
    });
  });

  it('get returns undefined for an unknown task; list() filters by status and tradeId', () => {
    const t1 = uuidv7();
    const t2 = uuidv7();
    const a = h.tasks.create({ trade_id: t1, task_type: 'PAY', instructions: 'a' });
    const b = h.tasks.create({ trade_id: t1, task_type: 'SHIP', instructions: 'b' });
    const c = h.tasks.create({ trade_id: t2, task_type: 'RECEIVE', instructions: 'c' });
    h.tasks.complete(a, { ok: true });

    expect(h.tasks.get(uuidv7())).toBeUndefined();

    expect(h.tasks.list().map((t) => t.task_id)).toEqual([a, b, c].sort());
    expect(h.tasks.list({ status: 'PENDING' }).map((t) => t.task_id)).toEqual([b, c].sort());
    expect(h.tasks.list({ status: 'DONE' }).map((t) => t.task_id)).toEqual([a]);
    expect(h.tasks.list({ tradeId: t1 }).map((t) => t.task_id)).toEqual([a, b].sort());
    expect(h.tasks.list({ tradeId: t2, status: 'PENDING' }).map((t) => t.task_id)).toEqual([c]);
    expect(h.tasks.list({ tradeId: uuidv7() })).toEqual([]);
  });

  it('complete: PENDING → DONE with the result recorded; a second complete throws', () => {
    const tradeId = uuidv7();
    const taskId = h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'pay' });

    h.tasks.complete(taskId, { confirmation: 'ref-1', amount: '100.00' });
    const done = h.tasks.get(taskId)!;
    expect(done.status).toBe('DONE');
    expect(done.result).toEqual({ confirmation: 'ref-1', amount: '100.00' });
    // file updated on disk too
    expect(JSON.parse(readFileSync(taskFile(taskId), 'utf8')).status).toBe('DONE');

    expect(() => h.tasks.complete(taskId, { confirmation: 'ref-2' })).toThrow(/only PENDING/);
    expect(() => h.tasks.complete(uuidv7(), { confirmation: 'x' })).toThrow(/unknown task/);
  });

  it('cancel: PENDING → CANCELLED; terminal for further transitions', () => {
    const tradeId = uuidv7();
    const taskId = h.tasks.create({ trade_id: tradeId, task_type: 'PURCHASE', instructions: 'buy' });

    h.tasks.cancel(taskId);
    expect(h.tasks.get(taskId)!.status).toBe('CANCELLED');
    expect(() => h.tasks.cancel(taskId)).toThrow(/only PENDING/);
    expect(() => h.tasks.complete(taskId, { ok: true })).toThrow(/only PENDING/);
    expect(() => h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey })).toThrow(/only DONE/);
  });

  it('complete on a DONE task, and cancel on a DONE task, both throw', () => {
    const tradeId = uuidv7();
    const taskId = donePayTask(tradeId);
    expect(() => h.tasks.cancel(taskId)).toThrow(/only PENDING/);
    expect(() => h.tasks.complete(taskId, { x: 1 })).toThrow(/only PENDING/);
  });

  it('validates create input', () => {
    const tradeId = uuidv7();
    // @ts-expect-error deliberate invalid task_type
    expect(() => h.tasks.create({ trade_id: tradeId, task_type: 'BOGUS', instructions: 'x' })).toThrow(/invalid task_type/);
    expect(() => h.tasks.create({ trade_id: '', task_type: 'PAY', instructions: 'x' })).toThrow(/trade_id/);
    expect(() => h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: '' })).toThrow(/instructions/);
    // @ts-expect-error deliberate invalid types
    expect(() => h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'x', deadline: 5 })).toThrow(/deadline/);
    // @ts-expect-error deliberate invalid required_output
    expect(() => h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'x', required_output: [1] })).toThrow(/required_output/);
    // @ts-expect-error complete result must be a plain object
    expect(() => h.tasks.complete(uuidv7(), 'not-an-object')).toThrow(/plain object/);
  });

  it('rejects non-uuid-v7 task ids (path safety)', () => {
    for (const bad of ['../evil', 'a'.repeat(36), 'not-a-uuid', '../../etc/passwd']) {
      expect(() => h.tasks.get(bad)).toThrow(/invalid task_id/);
      expect(() => h.tasks.complete(bad, { x: 1 })).toThrow(/invalid task_id/);
      expect(() => h.tasks.cancel(bad)).toThrow(/invalid task_id/);
      expect(() => h.tasks.toEvent(bad, 'PAYMENT_CONFIRMED', { agentId: 'a', secretKey: 'b' })).toThrow(/invalid task_id/);
    }
  });

  it('exposes exactly the card surface', () => {
    expect(Object.keys(h.tasks).sort()).toEqual(['cancel', 'complete', 'create', 'get', 'list', 'toEvent']);
  });
});

describe('M7 acceptance 2: M6 manual-settlement integration (simulated)', () => {
  it('PAY task → complete → toEvent(PAYMENT_CONFIRMED) → stateOf === PAYMENT_CONFIRMED', () => {
    const tradeId = uuidv7();
    // M6 flow starts from a signed deal on file
    const deal = makeDeal(tradeId, 'agent_buyer', 'agent_seller', h.buyer.secretKey);
    expect(h.store.putObject(deal)).toBe(objectId(deal));

    advanceToPending(tradeId); // request(): AGREED → PAYMENT_PENDING

    // manual-settlement: open a PAY human task, human completes it
    const taskId = h.tasks.create({
      trade_id: tradeId,
      task_type: 'PAY',
      instructions: 'Transfer 100.00 USD by manual settlement and report the confirmation reference.',
    });
    h.tasks.complete(taskId, { confirmation: 'manual-transfer-2026-0001', amount: '100.00', method: 'manual-settlement' });

    // the model mints PAYMENT_CONFIRMED from the completed task
    const event = h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey });

    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
    expect(verifyFile(event, resolveFrom({ agent_buyer: h.buyer }))).toBe('valid');
  });
});

describe('M7 acceptance 3: toEvent mints a valid signed event', () => {
  it('evidence carries the task result; message is auto-summarized; event persisted', () => {
    const tradeId = uuidv7();
    advanceToPending(tradeId);
    const result = { confirmation: 'manual-transfer-2026-0001', amount: '100.00' };
    const taskId = donePayTask(tradeId, result);

    const event = h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey });

    expect(verifyFile(event, resolveFrom({ agent_buyer: h.buyer }))).toBe('valid');
    const body = event.body as Record<string, unknown>;
    expect(body.event_type).toBe('PAYMENT_CONFIRMED');
    expect(body.trade_id).toBe(tradeId);
    expect(body.evidence).toEqual({ task_id: taskId, task_type: 'PAY', result });
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
    expect((body.message as string)).toContain(taskId);

    // applied events are immutable fact files
    expect(h.store.getObject(objectId(event))).toEqual(event);
    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
  });

  it('throws for non-DONE tasks (PENDING and CANCELLED)', () => {
    const tradeId = uuidv7();
    advanceToPending(tradeId);
    const pendingId = h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'pay' });
    const cancelledId = h.tasks.create({ trade_id: tradeId, task_type: 'PAY', instructions: 'pay' });
    h.tasks.cancel(cancelledId);
    const ctx = { agentId: 'agent_buyer', secretKey: h.buyer.secretKey };

    expect(() => h.tasks.toEvent(pendingId, 'PAYMENT_CONFIRMED', ctx)).toThrow(/only DONE/);
    expect(() => h.tasks.toEvent(cancelledId, 'PAYMENT_CONFIRMED', ctx)).toThrow(/only DONE/);
    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_PENDING'); // nothing applied
  });

  it('throws for unknown tasks and invalid event types', () => {
    const tradeId = uuidv7();
    advanceToPending(tradeId);
    const taskId = donePayTask(tradeId);
    const ctx = { agentId: 'agent_buyer', secretKey: h.buyer.secretKey };

    expect(() => h.tasks.toEvent(uuidv7(), 'PAYMENT_CONFIRMED', ctx)).toThrow(/unknown task/);
    expect(() => h.tasks.toEvent(taskId, 'NOT_AN_EVENT', ctx)).toThrow(/invalid event_type/);
    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_PENDING');
  });

  it('surfaces state-machine errors (event not legal in the current state)', () => {
    const tradeId = uuidv7();
    h.store.applyEvent(tradeId, makeEvent({ tradeId, eventType: 'DEAL_SIGNED', actor: 'agent_buyer', secretKey: h.buyer.secretKey })); // AGREED
    const taskId = donePayTask(tradeId);

    expect(() => h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey })).toThrow(
      /requires state PAYMENT_PENDING/,
    );
    expect(h.store.stateOf(tradeId)).toBe('AGREED'); // nothing persisted
  });

  it('an unknown signer fails toEvent (applyEvent surfaces fail:unknown_signer)', () => {
    const tradeId = uuidv7();
    advanceToPending(tradeId);
    const taskId = donePayTask(tradeId);
    // a real identity whose key is NOT in the trust ring: signing succeeds,
    // but applyEvent's verifyFile fails with unknown_signer
    const stranger = generateIdentity();
    expect(() => h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'stranger', secretKey: stranger.secretKey })).toThrow(
      /verification failed \(fail:unknown_signer\)/,
    );
    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_PENDING');
  });
});

describe('M7 acceptance 4: tasks survive index.sqlite deletion + rebuildIndex()', () => {
  it('list() is unchanged after rebuild; the tasks mirror is re-created', () => {
    const t1 = uuidv7();
    const t2 = uuidv7();
    advanceToPending(t1);
    advanceToPending(t2);

    const a = donePayTask(t1); // DONE
    h.tasks.toEvent(a, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey });
    const b = h.tasks.create({ trade_id: t2, task_type: 'SHIP', instructions: 'ship it' }); // PENDING
    const c = h.tasks.create({ trade_id: t1, task_type: 'INSPECT', instructions: 'inspect' }); // PENDING
    h.tasks.cancel(c); // CANCELLED

    // the mirror table is populated alongside the files
    expect(countMirrorRows(h.dir)).toBe(3);

    const before = h.tasks.list();

    // physically delete the disposable index, then rebuild from fact files
    rmSync(join(h.dir, '.data', 'index.sqlite'), { force: true });
    h.store.rebuildIndex();

    // tasks come back from .data/tasks/ files, unchanged
    expect(h.tasks.list()).toEqual(before);
    expect(h.tasks.get(a)!.status).toBe('DONE');
    expect(h.tasks.get(b)!.status).toBe('PENDING');
    expect(h.tasks.get(c)!.status).toBe('CANCELLED');
    // the store index itself survived too
    expect(h.store.stateOf(t1)).toBe('PAYMENT_CONFIRMED');
    // and list() re-created the tasks mirror in the rebuilt index.sqlite
    expect(countMirrorRows(h.dir)).toBe(3);
  });

  it('a filtered list() after rebuild still re-creates the full mirror', () => {
    const t1 = uuidv7();
    advanceToPending(t1);
    const a = donePayTask(t1); // DONE
    const b = h.tasks.create({ trade_id: t1, task_type: 'INSPECT', instructions: 'inspect' }); // PENDING

    rmSync(join(h.dir, '.data', 'index.sqlite'), { force: true });
    h.store.rebuildIndex();

    // first post-rebuild call is filtered — the mirror must still cover ALL tasks
    expect(h.tasks.list({ status: 'DONE' }).map((t) => t.task_id)).toEqual([a]);
    expect(countMirrorRows(h.dir)).toBe(2);
    expect(h.tasks.get(b)!.status).toBe('PENDING');
  });

  it('reopening the store after rebuild still lists the tasks', () => {
    const tradeId = uuidv7();
    advanceToPending(tradeId);
    const taskId = donePayTask(tradeId);
    h.tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId: 'agent_buyer', secretKey: h.buyer.secretKey });
    expect(h.store.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');

    rmSync(join(h.dir, '.data', 'index.sqlite'), { force: true });
    h.store.rebuildIndex();
    h.store.close();

    // same dir, fresh handles — task files are the durable state
    const dir = h.dir;
    const store2 = openStore(dir);
    const tasks2 = createHumanTaskStore(store2, { dir });
    try {
      expect(tasks2.get(taskId)).toMatchObject({ status: 'DONE', trade_id: tradeId });
      expect(store2.stateOf(tradeId)).toBe('PAYMENT_CONFIRMED');
    } finally {
      store2.close();
    }
  });
});
