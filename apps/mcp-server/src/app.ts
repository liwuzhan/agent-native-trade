/**
 * TradeApp — the stateful core behind the MCP server. One instance per
 * process (created at stdio entry), shared by every per-connection
 * {@linkcode McpServer} instance the factory produces.
 *
 * Owns:
 * - the local store (`openStore` → `<dir>/.data/` with objects/, keys/,
 *   index.sqlite) — the trust ring is derived from the secret keys under
 *   keys/, so a signer whose key was never saved locally is unknown,
 * - the signing policy (policy.json),
 * - the settlement adapters (test-voucher + manual-settlement), which carry
 *   per-instance state (voucher registry / task registry) that must survive
 *   across `settlement_request` → `settlement_confirm` calls.
 */

import { publicKeyFromSeed } from '@agent-trade/identity';
import { openStore } from '@agent-trade/local-store';
import type { Store } from '@agent-trade/local-store';
import {
  createManualSettlementAdapter,
  createTestVoucherAdapter,
} from '@agent-trade/settlement';
import type { SettlementAdapter, SettlementMethod } from '@agent-trade/settlement';

import { InMemoryHumanTaskStore } from './in-memory-tasks.js';
import { loadPolicy } from './policy.js';
import type { Policy } from './policy.js';

export interface TradeAppOptions {
  /** Root directory that contains `.data/` (same convention as openStore). */
  dir: string;
  /** Optional explicit policy; defaults to `.data/policy.json` → shipped policy.json. */
  policy?: Policy;
  /** Default signer/actor for tools that do not name one. */
  agentId?: string;
}

export interface TradeApp {
  dir: string;
  store: Store;
  policy: Policy;
  agentId: string;
  /** Resolve a signer's public key from the local keyring (`.data/keys/`). */
  resolveKey(signer: string): string | undefined;
  /** Read the local private key for an agent; undefined when absent. */
  secretKeyOf(agentId: string): string | undefined;
  taskStore: InMemoryHumanTaskStore;
  voucherAdapter: SettlementAdapter;
  manualAdapter: SettlementAdapter;
  adapterFor(method: SettlementMethod): SettlementAdapter;
  close(): void;
}

export function createTradeApp(opts: TradeAppOptions): TradeApp {
  const store = openStore(opts.dir);
  const taskStore = new InMemoryHumanTaskStore();
  const voucherAdapter = createTestVoucherAdapter();
  const manualAdapter = createManualSettlementAdapter({ taskStore });

  return {
    dir: opts.dir,
    store,
    policy: loadPolicy(opts.dir, opts.policy),
    agentId: opts.agentId ?? 'agent',
    resolveKey(signer: string): string | undefined {
      const seed = store.getKey(signer);
      return seed === undefined ? undefined : publicKeyFromSeed(seed);
    },
    secretKeyOf(agentId: string): string | undefined {
      return store.getKey(agentId);
    },
    taskStore,
    voucherAdapter,
    manualAdapter,
    adapterFor(method: SettlementMethod): SettlementAdapter {
      return method === 'manual-settlement' ? manualAdapter : voucherAdapter;
    },
    close(): void {
      store.close();
    },
  };
}
