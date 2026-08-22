/**
 * Test fixtures for M6. Uses fresh Ed25519 identities (no fixed seeds) and a
 * schema-valid DEAL builder, plus an in-memory HumanTaskStore implementing the
 * M7 structural contract (M7's real store is developed in parallel and must
 * not be imported here).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { generateIdentity, publicKeyFromSeed } from '@agent-trade/identity';
import type { Identity } from '@agent-trade/identity';
import { addSignature, buildObject } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';
import type { Store } from '@agent-trade/local-store';

import type { HumanTask, HumanTaskStore, TaskStatus } from '../src/human-task.js';
import { uuidV7 } from '../src/uuid.js';

/** An identity plus the agent id it acts under. */
export type Agent = Identity & { agentId: string };

export function makeAgent(agentId: string): Agent {
  return { agentId, ...generateIdentity() };
}

export interface DealParams {
  tradeId?: string;
  buyer: Agent;
  seller: Agent;
  amount?: string;
  asset?: string;
  method?: string;
}

/** Schema-valid DEAL signed by both parties (deal.schema.json). */
export function makeDeal(params: DealParams): SignedFile {
  const body = {
    trade_id: params.tradeId ?? uuidV7(),
    buyer: params.buyer.agentId,
    seller: params.seller.agentId,
    subject: {
      listing_ref: 'listing-001',
      description: 'Test goods',
      quantity: 1,
      acceptance_conditions: ['matches agreed spec'],
    },
    settlement: {
      asset: params.asset ?? 'USD',
      ...(params.amount !== undefined ? { amount: params.amount } : {}),
      method: params.method ?? 'test-voucher',
    },
    fulfillment: {
      deadline: '2026-09-01T00:00:00Z',
      destination_ref: 'dc-1',
      carrier_ref: 'carrier-1',
    },
  };
  const unsigned = buildObject('DEAL', body);
  return addSignature(
    addSignature(unsigned, params.buyer.agentId, params.buyer.secretKey),
    params.seller.agentId,
    params.seller.secretKey,
  );
}

export function tradeIdOf(deal: SignedFile): string {
  return (deal.body as { trade_id: string }).trade_id;
}

/** DEAL_SIGNED event that lands the trade in AGREED (initial event). */
export function dealSigned(deal: SignedFile, by: Agent): SignedFile {
  return addSignature(
    buildObject('TRADE_EVENT', {
      event_id: uuidV7(),
      trade_id: tradeIdOf(deal),
      event_type: 'DEAL_SIGNED',
      actor: by.agentId,
      occurred_at: new Date().toISOString(),
      message: 'deal signed',
    }),
    by.agentId,
    by.secretKey,
  );
}

/**
 * verifyFile key resolver backed by the store's own key ring (saveKey'd
 * identities) — mirrors how the store itself verifies signers.
 */
export function makeResolver(store: Store): (signer: string) => string | undefined {
  return (signer) => {
    const seed = store.getKey(signer);
    return seed === undefined ? undefined : publicKeyFromSeed(seed);
  };
}

/** Minimal in-memory HumanTaskStore satisfying the M7 structural contract. */
export class MemoryTaskStore implements HumanTaskStore {
  private readonly tasks = new Map<string, HumanTask>();

  create(t: Omit<HumanTask, 'task_id' | 'status'>): string {
    const task: HumanTask = { ...t, task_id: uuidV7(), status: 'PENDING' };
    this.tasks.set(task.task_id, task);
    return task.task_id;
  }

  get(taskId: string): HumanTask | undefined {
    return this.tasks.get(taskId);
  }

  list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[] {
    let out = [...this.tasks.values()];
    if (filter?.status !== undefined) out = out.filter((t) => t.status === filter.status);
    if (filter?.tradeId !== undefined) out = out.filter((t) => t.trade_id === filter.tradeId);
    return out;
  }

  complete(taskId: string, result: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== 'PENDING') throw new Error(`task ${taskId} is ${task.status}, cannot complete`);
    this.tasks.set(taskId, { ...task, status: 'DONE', result });
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== 'PENDING') throw new Error(`task ${taskId} is ${task.status}, cannot cancel`);
    this.tasks.set(taskId, { ...task, status: 'CANCELLED' });
  }

  /** Not used by the M6 adapter; kept for interface fidelity (build+sign only). */
  toEvent(taskId: string, eventType: string, ctx: { agentId: string; secretKey: string }): SignedFile {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== 'DONE') throw new Error(`task ${taskId} is ${task.status}, expected DONE`);
    return addSignature(
      buildObject('TRADE_EVENT', {
        event_id: uuidV7(),
        trade_id: task.trade_id,
        event_type: eventType,
        actor: ctx.agentId,
        occurred_at: new Date().toISOString(),
        evidence: { task_id: taskId, result: task.result ?? {} },
      }),
      ctx.agentId,
      ctx.secretKey,
    );
  }
}

// ---------------------------------------------------------------------------
// Acceptance 4: scan every persisted object/event for secret-like fields.
// ---------------------------------------------------------------------------

/** Field names that would indicate secret material leaked into public data. */
export const SECRET_FIELD_RE =
  /^(cardSecret|card_secret|cardsecret|password|passwd|passphrase|pin|pin_code|pincode|cvv|cvc|secret|token|apiKey|api_key|apikey|privateKey|private_key|seed|mnemonic|auth|credential|otp|2fa)$/i;

/** Same names for a raw-text scan (values included) — used on index.sqlite. */
export const SECRET_RAW_RE =
  /\b(cardsecret|password|passwd|passphrase|pin|pincode|cvv|cvc|secret|token|apikey|privatekey|seed|mnemonic|credential|otp|2fa)\b/i;

/** Collect every key path inside a SignedFile whose name looks secret. */
export function findSecretKeys(file: SignedFile): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_FIELD_RE.test(k)) hits.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(file, '$');
  return hits;
}

/**
 * Scan a store directory (`.data/` layout): every fact file under
 * objects/ (key scan + raw-text scan) and index.sqlite (raw-text scan, the
 * events table persists the same bodies). Returns human-readable violations;
 * empty array means clean. The keys/ directory is intentionally excluded — it
 * is the store's private 0600 keyring, not public data.
 */
export function scanStoreForSecrets(dir: string): string[] {
  const hits: string[] = [];
  const objectsDir = join(dir, '.data', 'objects');

  const walkDir = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walkDir(p);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const raw = readFileSync(p, 'utf8');
      const file = JSON.parse(raw) as SignedFile;
      for (const key of findSecretKeys(file)) hits.push(`${p}: field ${key}`);
      if (SECRET_RAW_RE.test(raw)) hits.push(`${p}: raw text contains a secret-like string`);
    }
  };
  if (existsSync(objectsDir)) walkDir(objectsDir);

  const indexPath = join(dir, '.data', 'index.sqlite');
  if (existsSync(indexPath)) {
    const raw = readFileSync(indexPath).toString('latin1');
    if (SECRET_RAW_RE.test(raw)) hits.push(`${indexPath}: raw text contains a secret-like string`);
  }
  return hits;
}
