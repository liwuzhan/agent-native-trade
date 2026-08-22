/**
 * TRADE_EVENT + status tools: trade_record_event builds a schema-valid
 * TRADE_EVENT, signs it with the actor's local key, and applies it through
 * the state machine (M3 `applyEvent` verifies the signature and the
 * transition before persisting). trade_get_status reads the current state.
 */

import { randomBytes } from 'node:crypto';

import { addSignature, buildObject, objectId } from '@agent-trade/signed-files';
import type { EventType } from '@agent-trade/local-store';

import type { TradeApp } from '../app.js';
import { validateBody } from '../schema.js';
import { isPlainObject } from '../shared.js';
import type { ToolSummary } from '../shared.js';

function uuidV7(): string {
  const bytes = new Uint8Array(16);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const rand = randomBytes(10);
  bytes.set(rand, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}: "${key}" is required (non-empty string)`);
  }
  return value;
}

/** trade_record_event — sign an event with the actor's local key and apply it. */
export async function recordEvent(args: Record<string, unknown>, app: TradeApp): Promise<ToolSummary> {
  const tradeId = requireString(args, 'trade_id', 'record_event');
  const eventType = requireString(args, 'event_type', 'record_event') as EventType;
  const actor = typeof args.actor === 'string' && args.actor.length > 0 ? (args.actor as string) : app.agentId;
  const secretKey = app.secretKeyOf(actor);
  if (secretKey === undefined) {
    throw new Error(`record_event: no private key for "${actor}" under .data/keys/`);
  }

  const body: Record<string, unknown> = {
    event_id: uuidV7(),
    trade_id: tradeId,
    event_type: eventType,
    actor,
    occurred_at: new Date().toISOString(),
  };
  if (isPlainObject(args.evidence)) body.evidence = args.evidence;
  if (typeof args.message === 'string') body.message = args.message;

  // validate the body (including the event_type enum) BEFORE signing
  await validateBody('TRADE_EVENT', body);

  const event = addSignature(buildObject('TRADE_EVENT', body), actor, secretKey);
  // applyEvent: full verification + state-machine transition; throws unless valid
  const state = app.store.applyEvent(tradeId, event);
  return {
    object_id: objectId(event),
    trade_id: tradeId,
    event_type: eventType,
    actor,
    state,
  };
}

/** trade_get_status — current state of a trade. object_id is the trade_id (the queried object). */
export function getStatus(args: Record<string, unknown>, app: TradeApp): ToolSummary {
  const tradeId = requireString(args, 'trade_id', 'get_status');
  const state = app.store.stateOf(tradeId);
  if (state === undefined) {
    throw new Error(`get_status: no events recorded for trade ${tradeId}`);
  }
  return { object_id: tradeId, trade_id: tradeId, state };
}
