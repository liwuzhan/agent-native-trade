/**
 * Real-stdio connectivity test (module card M9 acceptance 1, spawn variant):
 * the official MCP client spawns `node dist/index.js` as a child process and
 * talks to it over stdin/stdout — the exact deployment shape Claude Desktop /
 * Cursor use. This validates the stdio transport wiring end to end.
 *
 * Requires `dist/` to be built (`npm test` runs pretest → `tsc -b`).
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { loadVectorIdentities } from './helpers.js';
import { makeDealBody, dealEnvelope, callTool } from './helpers.js';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(APP_DIR, 'dist', 'index.js');

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('M9 stdio spawn (Claude Desktop / Cursor deployment shape)', () => {
  it('serves the ten tools and round-trips compile → sign → verify over real stdio', async () => {
    expect(existsSync(ENTRY), `dist entry missing: ${ENTRY} (run npm test / pretest first)`).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'mcp-server-stdio-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // Provision the local keyring exactly as the store expects
    // (<dir>/.data/keys/<encodeURIComponent(agentId)>.key = "<seed>\n").
    const keysDir = join(dir, '.data', 'keys');
    mkdirSync(keysDir, { recursive: true });
    for (const [agentId, identity] of Object.entries(loadVectorIdentities())) {
      writeFileSync(join(keysDir, `${encodeURIComponent(agentId)}.key`), identity.seed + '\n', 'utf8');
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, AGENT_TRADE_DATA_DIR: dir, AGENT_TRADE_AGENT_ID: 'agent_buyer' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'm9-stdio-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
    });

    // 1. listTools
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['trade_identity_create', 'trade_compile_deal', 'trade_sign_deal', 'trade_verify_deal', 'trade_record_event', 'trade_get_status', 'trade_create_receipt', 'trade_verify_receipt', 'settlement_request', 'settlement_confirm'].sort(),
    );

    // 2. compile → sign → verify round-trip over stdio
    const body = makeDealBody();
    const compiled = await callTool(client, 'trade_compile_deal', { body });
    expect(compiled.isError).toBe(false);
    const bodyHash = compiled.data!.body_hash as string;

    const signed = await callTool(client, 'trade_sign_deal', {
      deal: dealEnvelope(body, bodyHash),
      expected_body_hash: bodyHash,
      signer: 'agent_buyer',
    });
    expect(signed.isError, signed.text).toBe(false);
    expect(signed.data!.object_id).toMatch(/^sha256:[0-9a-f]{64}$/);

    const verified = await callTool(client, 'trade_verify_deal', { object_id: signed.data!.object_id });
    expect(verified.isError, verified.text).toBe(false);
    expect(verified.data!.result).toBe('valid');

    // 3. full happy path over stdio (identity_create → receipt verify)
    const identity = await callTool(client, 'trade_identity_create', {});
    expect(identity.isError, identity.text).toBe(false);
    expect(identity.data!.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tradeId = compiled.data!.trade_id as string;
    const agreed = await callTool(client, 'trade_record_event', { trade_id: tradeId, event_type: 'DEAL_SIGNED', actor: 'agent_buyer' });
    expect(agreed.data!.state).toBe('AGREED');
    const requested = await callTool(client, 'settlement_request', { object_id: signed.data!.object_id, method: 'test-voucher', actor: 'agent_buyer' });
    expect(requested.isError, requested.text).toBe(false);
    expect(requested.data!.state).toBe('PAYMENT_PENDING');
    const confirmed = await callTool(client, 'settlement_confirm', { object_id: signed.data!.object_id, method: 'test-voucher', actor: 'agent_seller' });
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(confirmed.data!.state).toBe('PAYMENT_CONFIRMED');
    const status = await callTool(client, 'trade_get_status', { trade_id: tradeId });
    expect(status.data!.state).toBe('PAYMENT_CONFIRMED');
  });
});
