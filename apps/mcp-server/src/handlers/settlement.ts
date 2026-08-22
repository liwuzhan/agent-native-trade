/**
 * Settlement tools (M6 adapters): settlement_request emits PAYMENT_REQUESTED
 * (AGREED → PAYMENT_PENDING), settlement_confirm emits PAYMENT_CONFIRMED
 * (→ PAYMENT_CONFIRMED). The deal must already be signed, verified against the
 * local trust ring, and the trade must be in the right state — the adapters
 * route every event through `store.applyEvent`, which re-verifies and enforces
 * the state machine.
 *
 * `method`: 'test-voucher' (default; fully fictional, in-memory) or
 * 'manual-settlement' (requires a human-completed PAY task before confirm).
 */

import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';
import type { SettlementMethod } from '@agent-trade/settlement';

import type { TradeApp } from '../app.js';
import { isPlainObject, resolveEnvelope } from '../shared.js';
import type { ToolSummary } from '../shared.js';

function requireValidDeal(app: TradeApp, deal: SignedFile, label: string): SignedFile {
  if (deal.object_type !== 'DEAL') {
    throw new Error(`${label}: expected a DEAL object, got ${JSON.stringify(deal.object_type)}`);
  }
  const result = verifyFile(deal, app.resolveKey);
  if (result !== 'valid') {
    throw new Error(`${label}: deal is not valid (${result}) — refusing to run settlement on it`);
  }
  // Persist as a fact (idempotent; already stored when signed locally).
  app.store.putObject(deal);
  return deal;
}

function tradeIdOf(deal: SignedFile): string {
  const body = isPlainObject(deal.body) ? deal.body : {};
  const tradeId = body.trade_id;
  if (typeof tradeId !== 'string' || tradeId.length === 0) {
    throw new Error(`settlement: DEAL body.trade_id is required`);
  }
  return tradeId;
}

function methodOf(value: unknown): SettlementMethod {
  return value === 'manual-settlement' ? 'manual-settlement' : 'test-voucher';
}

function actorAndKey(app: TradeApp, args: Record<string, unknown>, label: string): { actor: string; secretKey: string } {
  const actor = typeof args.actor === 'string' && args.actor.length > 0 ? (args.actor as string) : app.agentId;
  const secretKey = app.secretKeyOf(actor);
  if (secretKey === undefined) {
    throw new Error(`${label}: no private key for "${actor}" under .data/keys/`);
  }
  return { actor, secretKey };
}

/** settlement_request — buyer emits PAYMENT_REQUESTED (AGREED → PAYMENT_PENDING). */
export async function settlementRequest(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  const deal = requireValidDeal(app, resolveEnvelope(app, args.deal, args.object_id, 'settlement_request'), 'settlement_request');
  const method = methodOf(args.method);
  const { actor, secretKey } = actorAndKey(app, args, 'settlement_request');
  const event = await app.adapterFor(method).request(deal, { store: app.store, agentId: actor, secretKey });
  const state = app.store.stateOf(tradeIdOf(deal));
  return {
    object_id: objectId(event),
    trade_id: tradeIdOf(deal),
    method,
    event_type: 'PAYMENT_REQUESTED',
    state,
  };
}

/** settlement_confirm — seller/executor emits PAYMENT_CONFIRMED (→ PAYMENT_CONFIRMED). */
export async function settlementConfirm(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  const deal = requireValidDeal(app, resolveEnvelope(app, args.deal, args.object_id, 'settlement_confirm'), 'settlement_confirm');
  const method = methodOf(args.method);
  const { actor, secretKey } = actorAndKey(app, args, 'settlement_confirm');
  const event = await app.adapterFor(method).confirm(deal, { store: app.store, agentId: actor, secretKey });
  const state = app.store.stateOf(tradeIdOf(deal));
  return {
    object_id: objectId(event),
    trade_id: tradeIdOf(deal),
    method,
    event_type: 'PAYMENT_CONFIRMED',
    state,
  };
}
