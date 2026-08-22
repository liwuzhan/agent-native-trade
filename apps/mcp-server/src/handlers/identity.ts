/**
 * trade_identity_create — generate a fresh Ed25519 identity, persist its
 * private key under `.data/keys/` (mode 0600, same trust-ring as M3), and
 * return the agent id + public key. Never returns the private key.
 */

import { randomBytes } from 'node:crypto';

import { generateIdentity } from '@agent-trade/identity';

import type { TradeApp } from '../app.js';
import type { ToolSummary } from '../shared.js';

export function identityCreate(args: Record<string, unknown>, app: TradeApp): ToolSummary {
  const requested = typeof args.agentId === 'string' && args.agentId.length > 0 ? args.agentId : undefined;
  const agentId = requested ?? `agent_${randomBytes(4).toString('hex')}`;
  if (app.store.getKey(agentId) !== undefined) {
    throw new Error(`identity_create: agent "${agentId}" already has a local key (choose another agentId or omit it)`);
  }
  const identity = generateIdentity();
  app.store.saveKey(agentId, identity.secretKey);
  return {
    object_id: `identity:${agentId}`,
    agentId,
    publicKey: identity.publicKey,
    summary: `identity ${agentId} created, public key ${identity.publicKey}`,
  };
}
