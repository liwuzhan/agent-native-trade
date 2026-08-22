/**
 * CI smoke (module card M9 acceptance 1 + 3):
 *   - official MCP client (V2) brings the server up (in-process InMemory
 *     transport; the real stdio path is covered in stdio.test.ts);
 *   - listTools exposes exactly the ten required tools;
 *   - compile_deal → sign_deal → verify_deal round-trips;
 *   - a full trade happy path runs through every tool;
 *   - every tool response is < 500 chars and carries object_id.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CallOutcome, Connection } from './helpers.js';
import { callTool, connect, makeApp, makeDealBody, dealEnvelope } from './helpers.js';

const TOOL_NAMES = [
  'trade_identity_create',
  'trade_compile_deal',
  'trade_sign_deal',
  'trade_verify_deal',
  'trade_record_event',
  'trade_get_status',
  'trade_create_receipt',
  'trade_verify_receipt',
  'settlement_request',
  'settlement_confirm',
];

const MAX_RESPONSE_CHARS = 500;

const cleanups: Array<() => void> = [];
const connections: Connection[] = [];

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.close().catch(() => undefined);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function expectShortSummary(outcome: CallOutcome): Record<string, unknown> {
  expect(outcome.isError, `unexpected tool error: ${outcome.text}`).toBe(false);
  expect(outcome.text.length).toBeLessThan(MAX_RESPONSE_CHARS);
  const data = outcome.data;
  expect(data, 'response must carry structuredContent').toBeDefined();
  expect(data!.object_id, `response must carry object_id: ${outcome.text}`).toBeDefined();
  return data!;
}

describe('M9 CI smoke', () => {
  it('listTools exposes exactly the ten trade tools', async () => {
    const { app, cleanup } = makeApp();
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());

    // Red line: trade_sign_deal is the only signing tool — its input schema
    // admits deal + expected_body_hash (+ signer), never raw bytes/payloads.
    const signTool = tools.find((t) => t.name === 'trade_sign_deal');
    expect(signTool).toBeDefined();
    const props = (signTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['deal', 'expected_body_hash', 'signer']);
    expect((props.expected_body_hash as { pattern?: string }).pattern).toBe('^sha256:[0-9a-f]{64}$');
  });

  it('compile → sign → verify round-trips (acceptance 1)', async () => {
    const { app, cleanup } = makeApp();
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const body = makeDealBody();
    const compiled = expectShortSummary(await callTool(conn.client, 'trade_compile_deal', { body }));
    expect(compiled.body_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const envelope = dealEnvelope(body, compiled.body_hash as string);
    const signed = expectShortSummary(
      await callTool(conn.client, 'trade_sign_deal', {
        deal: envelope,
        expected_body_hash: compiled.body_hash,
        signer: 'agent_buyer',
      }),
    );
    expect(signed.object_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signed.signer).toBe('agent_buyer');

    // verify by object_id (the signed deal was persisted)
    const byId = expectShortSummary(await callTool(conn.client, 'trade_verify_deal', { object_id: signed.object_id }));
    expect(byId.result).toBe('valid');

    // verify by passing the signed envelope itself back — a real round-trip
    const stored = app.store.getObject(signed.object_id as string);
    expect(stored).toBeDefined();
    const byEnvelope = expectShortSummary(await callTool(conn.client, 'trade_verify_deal', { deal: stored }));
    expect(byEnvelope.result).toBe('valid');

    // a tampered signature on an otherwise intact envelope is caught by step ④
    const tampered = { ...stored!, signatures: [{ signer: 'agent_buyer', algorithm: 'Ed25519', signature: 'x'.repeat(86), issued_at: '2026-08-24T00:00:00Z' }] };
    const tamperedOutcome = expectShortSummary(await callTool(conn.client, 'trade_verify_deal', { deal: tampered }));
    expect(tamperedOutcome.result).toBe('fail:signature_invalid');
  });

  it('full trade happy path through all ten tools, every response < 500 chars', async () => {
    const { app, cleanup } = makeApp();
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    // 1. identity
    const identity = expectShortSummary(await callTool(conn.client, 'trade_identity_create', {}));
    expect(identity.agentId).toMatch(/^agent_[0-9a-f]{8}$/);
    expect(identity.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 2. compile
    const body = makeDealBody();
    const compiled = expectShortSummary(await callTool(conn.client, 'trade_compile_deal', { body }));
    const tradeId = compiled.trade_id as string;

    // 3. sign (buyer)
    const signed = expectShortSummary(
      await callTool(conn.client, 'trade_sign_deal', {
        deal: dealEnvelope(body, compiled.body_hash as string),
        expected_body_hash: compiled.body_hash,
        signer: 'agent_buyer',
      }),
    );
    const dealObjectId = signed.object_id as string;

    // 4. verify
    expect(expectShortSummary(await callTool(conn.client, 'trade_verify_deal', { object_id: dealObjectId })).result).toBe('valid');

    // 5. record DEAL_SIGNED → AGREED
    const agreed = expectShortSummary(await callTool(conn.client, 'trade_record_event', { trade_id: tradeId, event_type: 'DEAL_SIGNED', actor: 'agent_buyer' }));
    expect(agreed.state).toBe('AGREED');

    // 6. status
    const status = expectShortSummary(await callTool(conn.client, 'trade_get_status', { trade_id: tradeId }));
    expect(status.state).toBe('AGREED');

    // 7. settlement request → PAYMENT_PENDING
    const requested = expectShortSummary(await callTool(conn.client, 'settlement_request', { object_id: dealObjectId, method: 'test-voucher', actor: 'agent_buyer' }));
    expect(requested.state).toBe('PAYMENT_PENDING');

    // 8. settlement confirm → PAYMENT_CONFIRMED
    const confirmed = expectShortSummary(await callTool(conn.client, 'settlement_confirm', { object_id: dealObjectId, method: 'test-voucher', actor: 'agent_seller' }));
    expect(confirmed.state).toBe('PAYMENT_CONFIRMED');

    // 9. fulfillment chain → COMPLETED
    const chain: Array<[string, string, string]> = [
      ['FULFILLING', 'agent_seller', 'FULFILLING'],
      ['SHIPPED', 'agent_seller', 'SHIPPED'],
      ['DELIVERED', 'agent_seller', 'DELIVERED'],
      ['COMPLETED', 'agent_seller', 'COMPLETED'],
    ];
    for (const [eventType, actor, expectedState] of chain) {
      const ev = expectShortSummary(await callTool(conn.client, 'trade_record_event', { trade_id: tradeId, event_type: eventType, actor }));
      expect(ev.state).toBe(expectedState);
    }
    expect(expectShortSummary(await callTool(conn.client, 'trade_get_status', { trade_id: tradeId })).state).toBe('COMPLETED');

    // 10. receipt
    const receiptBody = {
      receipt_id: 'receipt-0001',
      trade_id: tradeId,
      contract_hash: dealObjectId,
      subject: 'agent_seller',
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      metrics: { specification_match: true, delivery_hours: 24, communication_score: 5, overall_score: 5 },
      transaction_summary: { category: 'hardware', asset: 'USDC', amount_disclosure: 'exact', amount_range: ['400.00', '440.00'] },
    };
    const receipt = expectShortSummary(await callTool(conn.client, 'trade_create_receipt', { body: receiptBody, signer: 'agent_buyer' }));
    const receiptObjectId = receipt.object_id as string;
    expect(receipt.receipt_id).toBe('receipt-0001');

    // 11. verify receipt
    expect(expectShortSummary(await callTool(conn.client, 'trade_verify_receipt', { object_id: receiptObjectId })).result).toBe('valid');
  });
});
