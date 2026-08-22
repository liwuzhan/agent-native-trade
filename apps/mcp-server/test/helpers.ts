/**
 * Test fixtures for mcp-server (module M9).
 *
 * Vector identities come from the authoritative protocol test-vectors
 * (specification.md: "权威源：protocol/test-vectors/"). Runtime code never
 * reads repo-relative paths — only tests do.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

import { createTradeApp } from '../src/app.js';
import type { TradeApp, TradeAppOptions } from '../src/app.js';
import { createTradeServer } from '../src/server.js';
import type { Policy } from '../src/policy.js';

export interface VectorIdentities {
  [agentId: string]: { public_key: string; seed: string };
}

export function loadVectorIdentities(): VectorIdentities {
  const url = new URL('../../../protocol/test-vectors/vectors.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(url, 'utf8')) as { identities: VectorIdentities };
  return vectors.identities;
}

export interface AppHarness {
  dir: string;
  app: TradeApp;
  cleanup(): void;
}

/** Fresh temp dir + TradeApp; vector keys (agent_buyer/agent_seller) saved. */
export function makeApp(opts: Partial<TradeAppOptions> & { policy?: Policy; withVectorKeys?: boolean } = {}): AppHarness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-server-'));
  const app = createTradeApp({ dir, ...opts });
  if (opts.withVectorKeys !== false) {
    for (const [agentId, identity] of Object.entries(loadVectorIdentities())) {
      app.store.saveKey(agentId, identity.seed);
    }
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

/** Pre-write a local policy override at `<dir>/.data/policy.json`. */
export function writeLocalPolicy(dir: string, policy: Policy): void {
  const dataDir = join(dir, '.data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'policy.json'), JSON.stringify(policy), 'utf8');
}

export interface CallOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | undefined;
}

/** callTool wrapper: a thrown protocol/SDK error counts as an error result. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return outcomeOf(result);
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error), data: undefined };
  }
}

export function outcomeOf(result: CallToolResult): CallOutcome {
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
  const data = result.structuredContent as Record<string, unknown> | undefined;
  return { isError: result.isError === true, text, data };
}

export interface Connection {
  client: Client;
  close(): Promise<void>;
}

/** In-process client↔server over InMemoryTransport. */
export async function connect(app: TradeApp): Promise<Connection> {
  const client = new Client({ name: 'm9-test-client', version: '0.0.0' }, { capabilities: {} });
  const server = createTradeServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** A valid DEAL body for the smoke tests. */
export function makeDealBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    trade_id: '01a02a10-d06d-7306-8a94-868702c2611e',
    buyer: 'agent_buyer',
    seller: 'agent_seller',
    subject: {
      listing_ref: 'sha256:9f6b6feedc2ddf9e27765a5b1a975c61e32fcd1191d6b552389c043cc56844f6',
      description: 'M8x40 304 stainless steel bolts, 40 mm',
      quantity: 100,
      acceptance_conditions: ['M8x40 304 stainless steel', 'packed per 100'],
    },
    settlement: {
      asset: 'USDC',
      amount: '420.00',
      method: 'test-voucher',
      provider_ref: 'test-voucher-issuer',
    },
    fulfillment: {
      deadline: '2026-09-01T00:00:00Z',
      destination_ref: 'shelf-a3',
      carrier_ref: 'test-carrier',
    },
  };
  return { ...body, ...overrides };
}

/** Reconstruct the draft DEAL envelope a model would pass to trade_sign_deal. */
export function dealEnvelope(body: Record<string, unknown>, bodyHash: string): Record<string, unknown> {
  return { protocol: 'agent-trade/0.2', object_type: 'DEAL', body, body_hash: bodyHash, signatures: [] };
}
