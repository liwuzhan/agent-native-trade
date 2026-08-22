/**
 * M6 settlement adapters: `test-voucher` and `manual-settlement`.
 *
 * Pushes a trade from AGREED through PAYMENT_PENDING → PAYMENT_CONFIRMED, and
 * provides the `markFulfilling` helper for the seller to reach FULFILLING
 * (payment ≠ completion; COMPLETED belongs to logistics, per the card).
 *
 * Design notes (card rules):
 * - Every produced TRADE_EVENT is signed, then `store.applyEvent` runs it
 *   through `verifyFile` (throws unless 'valid') and the state machine, so a
 *   returned event is by construction verifyFile-valid and applied.
 * - `evidence` holds only method / executor reference / credential (voucher or
 *   task) id — never secret material; the caller's `secretKey` is used solely
 *   to sign in memory and is never written into any persisted object.
 * - test-voucher is fully fictional: vouchers live in an in-memory registry on
 *   the adapter instance; redemption voids the code (double redemption is
 *   rejected). Face value is compared as an exact decimal fixed-point string
 *   ("3200.0" ≠ "3200.00").
 * - manual-settlement creates a PAY task through the injected HumanTaskStore
 *   (structural contract — M7's implementation is injected at runtime); after
 *   the human completes the task, the model (seller) signs PAYMENT_CONFIRMED.
 */

import { addSignature, buildObject } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';
import type { Store } from '@agent-trade/local-store';

import type { HumanTaskStore } from './human-task.js';
import { uuidV7 } from './uuid.js';

export interface SettlementContext {
  store: Store;
  agentId: string;
  secretKey: string;
}

export type SettlementMethod = 'test-voucher' | 'manual-settlement';

export interface SettlementAdapter {
  method: SettlementMethod;
  /** Buyer emits PAYMENT_REQUESTED; applies it (AGREED → PAYMENT_PENDING). */
  request(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>;
  /** Seller/executor emits PAYMENT_CONFIRMED; applies it (→ PAYMENT_CONFIRMED). */
  confirm(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>;
}

export interface MarkFulfillingOptions {
  /** Settlement method to record in evidence.method (optional). */
  method?: string;
  message?: string;
}

/** TRADE_EVENT body shapes we produce (schema-verified by applyEvent). */
type SettlementEventType = 'PAYMENT_REQUESTED' | 'PAYMENT_CONFIRMED' | 'FULFILLING';

interface EventParams {
  tradeId: string;
  eventType: SettlementEventType;
  actor: string;
  secretKey: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

/**
 * Exact decimal fixed-point string, matching the DEAL schema's `decimal`
 * definition (`^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$`). Comparison is character
 * exact — "3200.0" and "3200.00" are different face values.
 */
const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/;

/** Deal body fields this adapter reads. */
interface DealBody {
  trade_id?: unknown;
  settlement?: { amount?: unknown; asset?: unknown };
}

function tradeIdOf(deal: SignedFile): string {
  if (deal.object_type !== 'DEAL') {
    throw new Error(`settlement adapter: expected a DEAL object, got ${String(deal.object_type)}`);
  }
  const tradeId = (deal.body as DealBody).trade_id;
  if (typeof tradeId !== 'string' || tradeId.length === 0) {
    throw new Error('settlement adapter: DEAL body.trade_id is required');
  }
  return tradeId;
}

/** Raw amount string as written on the deal; undefined when absent. */
function amountOf(deal: SignedFile): string | undefined {
  const amount = (deal.body as DealBody).settlement?.amount;
  return typeof amount === 'string' ? amount : undefined;
}

/** Amount required to issue a voucher: present and a well-formed decimal. */
function requireDecimalAmount(deal: SignedFile): string {
  const amount = amountOf(deal);
  if (amount === undefined) {
    throw new Error('test-voucher: deal.body.settlement.amount is required (decimal fixed-point string)');
  }
  if (!DECIMAL_RE.test(amount)) {
    throw new Error(`test-voucher: amount ${JSON.stringify(amount)} is not a decimal fixed-point string`);
  }
  return amount;
}

function assetOf(deal: SignedFile): string {
  const asset = (deal.body as DealBody).settlement?.asset;
  return typeof asset === 'string' ? asset : '';
}

function buildEvent(params: EventParams): SignedFile {
  const body: Record<string, unknown> = {
    event_id: uuidV7(),
    trade_id: params.tradeId,
    event_type: params.eventType,
    actor: params.actor,
    occurred_at: new Date().toISOString(),
  };
  if (params.evidence !== undefined) body.evidence = params.evidence;
  if (params.message !== undefined) body.message = params.message;
  return addSignature(buildObject('TRADE_EVENT', body), params.actor, params.secretKey);
}

/**
 * Sign then apply. `store.applyEvent` verifies the signature/envelope first
 * (throws on anything but 'valid') and validates the state transition before
 * persisting, so a successful return means verifyFile === 'valid' AND the
 * chain advanced.
 */
function emitAndApply(store: Store, params: EventParams): SignedFile {
  const event = buildEvent(params);
  store.applyEvent(params.tradeId, event);
  return event;
}

// ---------------------------------------------------------------------------
// test-voucher
// ---------------------------------------------------------------------------

interface VoucherRecord {
  id: string;
  tradeId: string;
  /** Face value: exact decimal fixed-point string copied from the deal. */
  faceValue: string;
  status: 'ISSUED' | 'REDEEMED';
}

export const DEFAULT_TEST_VOUCHER_ISSUER = 'test-voucher-issuer';

/**
 * Fully fictional voucher adapter. The voucher registry is in-memory and
 * scoped to one adapter instance (test/scratch tooling only — the card
 * explicitly excludes real payment/wallet infrastructure).
 */
export function createTestVoucherAdapter(opts: { issuer?: string } = {}): SettlementAdapter {
  const issuer = opts.issuer ?? DEFAULT_TEST_VOUCHER_ISSUER;
  const vouchers = new Map<string, VoucherRecord>(); // voucher id → record
  const byTrade = new Map<string, string>(); // trade id → voucher id

  return {
    method: 'test-voucher',

    async request(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile> {
      const tradeId = tradeIdOf(deal);
      const faceValue = requireDecimalAmount(deal); // reject missing/malformed amount
      const voucherId = `TEST-VOUCHER-${uuidV7()}`;
      // Apply first: a failed applyEvent (e.g. trade not AGREED) must not
      // leave a registered voucher behind.
      const event = emitAndApply(ctx.store, {
        tradeId,
        eventType: 'PAYMENT_REQUESTED',
        actor: ctx.agentId,
        secretKey: ctx.secretKey,
        evidence: { method: 'test-voucher', voucher_id: voucherId, executor_ref: issuer },
        message: `payment requested for ${faceValue} ${assetOf(deal)} (test voucher ${voucherId})`,
      });
      vouchers.set(voucherId, { id: voucherId, tradeId, faceValue, status: 'ISSUED' });
      byTrade.set(tradeId, voucherId);
      return event;
    },

    async confirm(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile> {
      const tradeId = tradeIdOf(deal);
      const voucherId = byTrade.get(tradeId);
      if (voucherId === undefined) {
        throw new Error(`test-voucher: no voucher issued for trade ${tradeId} (call request first)`);
      }
      const record = vouchers.get(voucherId)!;
      // Face value must match the deal amount character-for-character
      // ("3200.00" ≠ "3200.0"); the deal handed to confirm is re-read so a
      // tampered/divergent deal is refused.
      const dealAmount = amountOf(deal);
      if (dealAmount !== record.faceValue) {
        throw new Error(
          `test-voucher: voucher face value ${JSON.stringify(record.faceValue)} does not exactly match ` +
            `deal settlement.amount ${JSON.stringify(dealAmount)} (exact decimal fixed-point string required)`,
        );
      }
      if (record.status === 'REDEEMED') {
        throw new Error(`test-voucher: voucher ${voucherId} already redeemed (double redemption rejected)`);
      }
      record.status = 'REDEEMED'; // 核销即作废
      return emitAndApply(ctx.store, {
        tradeId,
        eventType: 'PAYMENT_CONFIRMED',
        actor: ctx.agentId,
        secretKey: ctx.secretKey,
        evidence: { method: 'test-voucher', voucher_id: voucherId, executor_ref: ctx.agentId },
        message: `payment confirmed with test voucher ${voucherId}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// manual-settlement
// ---------------------------------------------------------------------------

function paymentInstructions(deal: SignedFile, tradeId: string): string {
  const amount = amountOf(deal);
  const asset = assetOf(deal);
  const what = amount !== undefined ? `${amount} ${asset}`.trim() : 'the agreed amount';
  return (
    `Pay ${what} for trade ${tradeId} (settlement method: manual-settlement). ` +
    'After completing the payment, record the payment reference as required_output.'
  );
}

/**
 * Human-in-the-loop settlement: request creates a PAY task in the injected
 * HumanTaskStore; once the human completes it, `confirm` (signed by the model
 * / seller) advances the trade to PAYMENT_CONFIRMED.
 */
export function createManualSettlementAdapter(opts: { taskStore: HumanTaskStore }): SettlementAdapter {
  const taskByTrade = new Map<string, string>(); // trade id → task id

  return {
    method: 'manual-settlement',

    async request(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile> {
      const tradeId = tradeIdOf(deal);
      const taskId = opts.taskStore.create({
        trade_id: tradeId,
        task_type: 'PAY',
        instructions: paymentInstructions(deal, tradeId),
        required_output: ['payment_reference'],
      });
      const event = emitAndApply(ctx.store, {
        tradeId,
        eventType: 'PAYMENT_REQUESTED',
        actor: ctx.agentId,
        secretKey: ctx.secretKey,
        evidence: { method: 'manual-settlement', task_id: taskId },
        message: `payment requested for trade ${tradeId}; human task ${taskId} created`,
      });
      taskByTrade.set(tradeId, taskId);
      return event;
    },

    async confirm(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile> {
      const tradeId = tradeIdOf(deal);
      const taskId = taskByTrade.get(tradeId);
      if (taskId === undefined) {
        throw new Error(`manual-settlement: no PAY task for trade ${tradeId} (call request first)`);
      }
      const task = opts.taskStore.get(taskId);
      if (task === undefined) {
        throw new Error(`manual-settlement: task ${taskId} not found in task store`);
      }
      if (task.status !== 'DONE') {
        throw new Error(
          `manual-settlement: task ${taskId} is ${task.status}, expected DONE (human must complete the PAY task first)`,
        );
      }
      return emitAndApply(ctx.store, {
        tradeId,
        eventType: 'PAYMENT_CONFIRMED',
        actor: ctx.agentId,
        secretKey: ctx.secretKey,
        evidence: { method: 'manual-settlement', task_id: taskId, executor_ref: ctx.agentId },
        message: `payment confirmed after human task ${taskId}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// markFulfilling
// ---------------------------------------------------------------------------

/**
 * Seller-signed FULFILLING event (PAYMENT_CONFIRMED → FULFILLING). Payment is
 * done; the seller now starts fulfilling the order. COMPLETED is out of scope
 * (logistics events, card boundary).
 */
export async function markFulfilling(
  deal: SignedFile,
  ctx: SettlementContext,
  opts: MarkFulfillingOptions = {},
): Promise<SignedFile> {
  const tradeId = tradeIdOf(deal);
  const evidence: Record<string, unknown> = { executor_ref: ctx.agentId };
  if (opts.method !== undefined) evidence.method = opts.method;
  return emitAndApply(ctx.store, {
    tradeId,
    eventType: 'FULFILLING',
    actor: ctx.agentId,
    secretKey: ctx.secretKey,
    evidence,
    message: opts.message,
  });
}
