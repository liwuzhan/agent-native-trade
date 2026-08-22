/**
 * settlement_request / settlement_confirm with the manual-settlement method:
 * request creates a human PAY task and moves the trade to PAYMENT_PENDING;
 * confirm is refused while the task is still pending (no human confirmation
 * shortcut — the human-in-the-loop gate is structural) and succeeds only
 * after the task is DONE.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { TradeApp } from '../src/app.js';
import type { Connection } from './helpers.js';
import { callTool, connect, makeApp, makeDealBody, dealEnvelope } from './helpers.js';

const cleanups: Array<() => void> = [];
const connections: Connection[] = [];
const apps: TradeApp[] = [];

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.close().catch(() => undefined);
  for (const cleanup of cleanups.splice(0)) cleanup();
  apps.length = 0;
});

async function setup(): Promise<{ conn: Connection; app: TradeApp }> {
  const { app, cleanup } = makeApp();
  cleanups.push(cleanup);
  apps.push(app);
  const conn = await connect(app);
  connections.push(conn);
  return { conn, app };
}

async function signedDeal(conn: Connection): Promise<{ objectId: string; tradeId: string }> {
  const body = makeDealBody();
  const compiled = await callTool(conn.client, 'trade_compile_deal', { body });
  if (compiled.isError) throw new Error(compiled.text);
  const bodyHash = compiled.data!.body_hash as string;
  const signed = await callTool(conn.client, 'trade_sign_deal', { deal: dealEnvelope(body, bodyHash), expected_body_hash: bodyHash, signer: 'agent_buyer' });
  if (signed.isError) throw new Error(signed.text);
  const agreed = await callTool(conn.client, 'trade_record_event', { trade_id: compiled.data!.trade_id as string, event_type: 'DEAL_SIGNED', actor: 'agent_buyer' });
  if (agreed.isError) throw new Error(agreed.text);
  return { objectId: signed.data!.object_id as string, tradeId: compiled.data!.trade_id as string };
}

describe('M9 manual-settlement', () => {
  it('request creates a human PAY task; confirm is refused until the task is DONE', async () => {
    const { conn, app } = await setup();
    const { objectId, tradeId } = await signedDeal(conn);

    // request → PAYMENT_PENDING + a PAY task exists
    const requested = await callTool(conn.client, 'settlement_request', { object_id: objectId, method: 'manual-settlement', actor: 'agent_buyer' });
    expect(requested.isError, requested.text).toBe(false);
    expect(requested.data!.state).toBe('PAYMENT_PENDING');
    const tasks = app.taskStore.list({ tradeId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_type).toBe('PAY');
    expect(tasks[0].status).toBe('PENDING');

    // confirm while the task is still pending → refused (no shortcut)
    const early = await callTool(conn.client, 'settlement_confirm', { object_id: objectId, method: 'manual-settlement', actor: 'agent_seller' });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('DONE');

    // human completes the task (out-of-band, M7-owned in production)
    app.taskStore.complete(tasks[0].task_id, { payment_reference: 'ref-0001' });

    const confirmed = await callTool(conn.client, 'settlement_confirm', { object_id: objectId, method: 'manual-settlement', actor: 'agent_seller' });
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(confirmed.data!.state).toBe('PAYMENT_CONFIRMED');
  });

  it('refuses settlement when the deal is not valid', async () => {
    const { conn } = await setup();
    const body = makeDealBody();
    const compiled = await callTool(conn.client, 'trade_compile_deal', { body });
    const bodyHash = compiled.data!.body_hash as string;
    // unsigned draft — not valid
    const outcome = await callTool(conn.client, 'settlement_request', { deal: dealEnvelope(body, bodyHash), method: 'test-voucher', actor: 'agent_buyer' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('not valid');
  });

  it('refuses settlement before DEAL_SIGNED is recorded (state machine)', async () => {
    const { conn } = await setup();
    const body = makeDealBody();
    const compiled = await callTool(conn.client, 'trade_compile_deal', { body });
    const bodyHash = compiled.data!.body_hash as string;
    const signed = await callTool(conn.client, 'trade_sign_deal', { deal: dealEnvelope(body, bodyHash), expected_body_hash: bodyHash, signer: 'agent_buyer' });
    // no DEAL_SIGNED event yet → trade has no state
    const outcome = await callTool(conn.client, 'settlement_request', { object_id: signed.data!.object_id, method: 'test-voucher', actor: 'agent_buyer' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('transition');
  });
});
