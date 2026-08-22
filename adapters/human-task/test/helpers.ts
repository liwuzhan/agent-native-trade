import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateIdentity, publicKeyFromSeed } from '@agent-trade/identity';
import type { Identity } from '@agent-trade/identity';
import { openStore } from '@agent-trade/local-store';
import type { Store } from '@agent-trade/local-store';
import { addSignature, buildObject } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import { createHumanTaskStore, uuidv7 } from '../src/index.js';
import type { HumanTaskStore } from '../src/index.js';

export function makeTempDir(prefix = 'human-task-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Harness {
  dir: string;
  store: Store;
  tasks: HumanTaskStore;
  buyer: Identity;
  seller: Identity;
}

/** Fresh temp store + human-task store; buyer's and seller's keys in the trust ring. */
export function setup(prefix = 'human-task-'): Harness {
  const dir = makeTempDir(prefix);
  const store = openStore(dir);
  const buyer = generateIdentity();
  const seller = generateIdentity();
  store.saveKey('agent_buyer', buyer.secretKey);
  store.saveKey('agent_seller', seller.secretKey);
  const tasks = createHumanTaskStore(store, { dir });
  return { dir, store, tasks, buyer, seller };
}

export interface EventParams {
  tradeId: string;
  eventType: string;
  actor: string;
  secretKey: string;
  occurredAt?: string;
  message?: string;
  eventId?: string;
}

/** Build a single-signed, schema-valid TRADE_EVENT. */
export function makeEvent(p: EventParams): SignedFile {
  const body: Record<string, unknown> = {
    event_id: p.eventId ?? uuidv7(),
    trade_id: p.tradeId,
    event_type: p.eventType,
    actor: p.actor,
    occurred_at: p.occurredAt ?? new Date().toISOString(),
  };
  if (p.message !== undefined) body.message = p.message;
  return addSignature(buildObject('TRADE_EVENT', body), p.actor, p.secretKey);
}

/** Build a schema-valid DEAL (uuid v7 trade_id; manual-settlement method). */
export function makeDeal(tradeId: string, buyer: string, seller: string, secretKey: string): SignedFile {
  return addSignature(
    buildObject('DEAL', {
      trade_id: tradeId,
      buyer,
      seller,
      subject: {
        listing_ref: 'listing-ref-1',
        description: 'one widget',
        quantity: 1,
        acceptance_conditions: ['works as described'],
      },
      settlement: { asset: 'USD', amount: '100.00', method: 'manual-settlement' },
      fulfillment: {
        deadline: '2026-09-01T00:00:00Z',
        destination_ref: 'destination-1',
        carrier_ref: 'carrier-1',
      },
    }),
    buyer,
    secretKey,
  );
}

/** resolveKey for verifyFile assertions: public key derived from the harness identity. */
export function resolveFrom(identities: Record<string, Identity>): (signer: string) => string | undefined {
  return (signer: string) => {
    const ident = identities[signer];
    return ident === undefined ? undefined : publicKeyFromSeed(ident.secretKey);
  };
}
