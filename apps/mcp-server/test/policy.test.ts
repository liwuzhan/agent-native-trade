/**
 * Signing policy (module card M9): a configurable `max_amount_per_deal` cap
 * refuses over-budget deals and returns the reason; at-cap and barter deals
 * pass. Policy comes from an explicit option or a local `.data/policy.json`
 * override; a malformed policy fails fast at app creation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTradeApp } from '../src/app.js';
import { loadVectorIdentities } from './helpers.js';
import type { Connection } from './helpers.js';
import { callTool, connect, makeApp, makeDealBody, dealEnvelope, writeLocalPolicy } from './helpers.js';

const cleanups: Array<() => void> = [];
const connections: Connection[] = [];

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.close().catch(() => undefined);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** App over an existing dir (re-reads .data/policy.json at creation). */
function appOver(dir: string): ReturnType<typeof makeApp> {
  const app = createTradeApp({ dir });
  for (const [agentId, identity] of Object.entries(loadVectorIdentities())) {
    app.store.saveKey(agentId, identity.seed);
  }
  return {
    dir,
    app,
    cleanup() {
      try {
        app.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

describe('M9 signing policy', () => {
  it('refuses a deal over max_amount_per_deal and returns the reason', async () => {
    const { app, cleanup } = makeApp({ policy: { max_amount_per_deal: '100.00' } });
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const body = makeDealBody({ settlement: { asset: 'USDC', amount: '200.00', method: 'test-voucher' } });
    const { envelope, bodyHash } = await compileDraft(conn, body);
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('max_amount_per_deal');
    expect(outcome.text).toContain('200.00');
  });

  it('allows a deal exactly at the cap', async () => {
    const { app, cleanup } = makeApp({ policy: { max_amount_per_deal: '100.00' } });
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const body = makeDealBody({ settlement: { asset: 'USDC', amount: '100.00', method: 'test-voucher' } });
    const { envelope, bodyHash } = await compileDraft(conn, body);
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(false);
  });

  it('allows barter deals (no amount) under a cap', async () => {
    const { app, cleanup } = makeApp({ policy: { max_amount_per_deal: '0.01' } });
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const body = makeDealBody({
      settlement: { asset: 'BARTER', method: 'manual', consideration: [{ item: 'widget', quantity: 2 }] },
    });
    const { envelope, bodyHash } = await compileDraft(conn, body);
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(false);
  });

  it('defaults to the shipped policy.json (no cap)', async () => {
    const { app, cleanup } = makeApp();
    cleanups.push(cleanup);
    const conn = await connect(app);
    connections.push(conn);

    const body = makeDealBody({ settlement: { asset: 'USDC', amount: '99999999.00', method: 'test-voucher' } });
    const { envelope, bodyHash } = await compileDraft(conn, body);
    const outcome = await callTool(conn.client, 'trade_sign_deal', {
      deal: envelope,
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(outcome.isError).toBe(false);
  });

  it('reads a local .data/policy.json override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-server-policy-'));
    try {
      writeLocalPolicy(dir, { max_amount_per_deal: '50.00' });
      const { app, cleanup } = appOver(dir);
      cleanups.push(cleanup);
      const conn = await connect(app);
      connections.push(conn);

      const body = makeDealBody({ settlement: { asset: 'USDC', amount: '75.00', method: 'test-voucher' } });
      const { envelope, bodyHash } = await compileDraft(conn, body);
      const outcome = await callTool(conn.client, 'trade_sign_deal', {
        deal: envelope,
        expected_body_hash: bodyHash,
        signer: 'agent_buyer',
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('max_amount_per_deal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast on a malformed policy value', () => {
    expect(() => makeApp({ policy: { max_amount_per_deal: 'not-a-number' } })).toThrow(/max_amount_per_deal/);
  });
});

/** Compile a deal through the tool and return envelope + correct hash. */
async function compileDraft(conn: Connection, body: Record<string, unknown>): Promise<{ envelope: Record<string, unknown>; bodyHash: string }> {
  const compiled = await callTool(conn.client, 'trade_compile_deal', { body });
  if (compiled.isError) throw new Error(`compile failed: ${compiled.text}`);
  return { envelope: dealEnvelope(body, compiled.data!.body_hash as string), bodyHash: compiled.data!.body_hash as string };
}
