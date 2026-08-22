/**
 * Signing red line (module card M9): trade_sign_deal must refuse
 *   - a wrong expected_body_hash,
 *   - non-DEAL objects / arbitrary bytes,
 *   - bodies that fail the DEAL schema,
 *   - inconsistent drafts (envelope hash ≠ expected hash),
 *   - unknown signers (no private key under .data/keys/),
 * and there must be NO generic arbitrary-byte signing tool.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { jcs, sha256Hex } from '@agent-trade/identity';

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

/** Draft envelope + correct body_hash for a given body. */
async function draftFor(conn: Connection, body: Record<string, unknown>): Promise<{ envelope: Record<string, unknown>; bodyHash: string }> {
  const compiled = await callTool(conn.client, 'trade_compile_deal', { body });
  if (compiled.isError) throw new Error(`compile failed: ${compiled.text}`);
  return { envelope: dealEnvelope(body, compiled.data!.body_hash as string), bodyHash: compiled.data!.body_hash as string };
}

describe('M9 signing red line', () => {
  it('rejects a wrong expected_body_hash (改 hash 攻击)', async () => {
    const { conn } = await setup();
    const body = makeDealBody();
    const { envelope, bodyHash } = await draftFor(conn, body);

    const wrong = bodyHash === 'sha256:' + '0'.repeat(64) ? 'sha256:' + '1'.repeat(64) : 'sha256:' + '0'.repeat(64);
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: wrong,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('body_hash mismatch');
    expect(outcome.text).not.toContain('signed');
  });

  it('rejects a malformed expected_body_hash', async () => {
    const { conn } = await setup();
    const { envelope } = await draftFor(conn, makeDealBody());
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: 'not-a-hash',
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('expected_body_hash');
  });

  it('rejects a non-object deal (arbitrary bytes/string)', async () => {
    const { conn } = await setup();
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: 'c2lnbiB0aGVzZSBieXRlcyE=', // arbitrary byte string
      expected_body_hash: 'sha256:' + '0'.repeat(64),
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('deal');
  });

  it('rejects a non-DEAL envelope object', async () => {
    const { conn } = await setup();
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: { protocol: 'agent-trade/0.2', object_type: 'TRADE_EVENT', body: {}, body_hash: 'sha256:' + '0'.repeat(64), signatures: [] },
      expected_body_hash: 'sha256:' + '0'.repeat(64),
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('DEAL');
  });

  it('rejects a deal body that fails the DEAL schema', async () => {
    const { conn } = await setup();
    // quantity must be a positive integer; acceptance_conditions is required.
    // compile_deal rejects this body too, so compute the hash directly (the
    // hash is consistent — the ONLY failure must be the schema check).
    const bad = makeDealBody({ subject: { listing_ref: 'x', description: 'y', quantity: -1 } });
    const bodyHash = 'sha256:' + sha256Hex(jcs(bad));
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: dealEnvelope(bad, bodyHash),
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('body schema invalid');
  });

  it('rejects a draft whose envelope body_hash disagrees with expected_body_hash', async () => {
    const { conn } = await setup();
    const body = makeDealBody();
    const { envelope, bodyHash } = await draftFor(conn, body);
    const inconsistent = { ...envelope, body_hash: 'sha256:' + 'f'.repeat(64) };
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: inconsistent,
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('inconsistent draft');
  });

  it('rejects a signer with no private key under .data/keys/', async () => {
    const { conn } = await setup();
    const { envelope, bodyHash } = await draftFor(conn, makeDealBody());
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: bodyHash,
      signer: 'someone-not-provisioned',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('no private key');
  });

  it('rejects when the body was tampered after compilation (改 body 不改 hash)', async () => {
    const { conn } = await setup();
    const body = makeDealBody();
    const { bodyHash } = await draftFor(conn, body);
    // body changes the amount but keeps the ORIGINAL body_hash from compile —
    // the recompute must catch the mismatch
    const tampered = { ...body, settlement: { ...(body.settlement as object), amount: '99999999.00' } };
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: dealEnvelope(tampered, bodyHash),
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('body_hash mismatch');
  });

  it('exposes no generic arbitrary-byte signing tool and appends, never re-signs, prior signatures', async () => {
    const { conn } = await setup();
    const { tools } = await conn.client.listTools();
    const signingTools = tools.filter((t) => /sign/.test(t.name));
    expect(signingTools.map((t) => t.name)).toEqual(['trade_sign_deal']);

    // multi-party signing: seller appends to the buyer-signed deal
    const body = makeDealBody();
    const { envelope, bodyHash } = await draftFor(conn, body);
    const buyerSigned = await callTool(conn.client, 'trade_sign_deal', { deal: envelope, expected_body_hash: bodyHash, signer: 'agent_buyer' });
    expect(buyerSigned.isError).toBe(false);
    const stored = apps[apps.length - 1].store.getObject(buyerSigned.data!.object_id as string);
    expect(stored).toBeDefined();
    expect(stored!.signatures).toHaveLength(1);

    const sellerSigned = await callTool(conn.client, 'trade_sign_deal', { deal: stored, expected_body_hash: bodyHash, signer: 'agent_seller' });
    expect(sellerSigned.isError).toBe(false);
    const storedTwice = apps[apps.length - 1].store.getObject(sellerSigned.data!.object_id as string);
    expect(storedTwice!.signatures).toHaveLength(2);
    const verified = await callTool(conn.client, 'trade_verify_deal', { object_id: sellerSigned.data!.object_id as string });
    expect(verified.data!.result).toBe('valid');
  });

  it('trade_verify_deal refuses non-DEAL objects', async () => {
    const { conn } = await setup();
    const outcome = await callTool(conn.client, 'trade_verify_deal', {
      deal: { protocol: 'agent-trade/0.2', object_type: 'TRADE_EVENT', body: {}, body_hash: 'sha256:' + '0'.repeat(64), signatures: [] },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('DEAL');
  });

  it('envelope-or-object_id resolution refuses ambiguous or empty input', async () => {
    const { conn } = await setup();
    const both = await callTool(conn.client, 'trade_verify_deal', {
      deal: { protocol: 'agent-trade/0.2', object_type: 'DEAL', body: {}, body_hash: 'sha256:' + '0'.repeat(64), signatures: [] },
      object_id: 'sha256:' + '0'.repeat(64),
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one');

    const none = await callTool(conn.client, 'trade_verify_deal', {});
    expect(none.isError).toBe(true);
    expect(none.text).toContain('exactly one');

    const missing = await callTool(conn.client, 'trade_verify_deal', { object_id: 'sha256:' + 'a'.repeat(64) });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no stored object');
  });

  it('trade_get_status on an unknown trade is an error', async () => {
    const { conn } = await setup();
    const outcome = await callTool(conn.client, 'trade_get_status', { trade_id: '01a02a10-d06d-7306-8a94-868702c2611e' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('no events');
  });
});
