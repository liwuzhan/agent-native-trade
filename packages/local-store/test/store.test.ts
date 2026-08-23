import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { publicKeyFromSeed } from '@agent-trade/identity';
import { buildObject, objectId } from '@agent-trade/signed-files';

import { openStore } from '../src/index.js';
import type { Store, TradeState } from '../src/index.js';
import { at, loadVectors, makeEvent, mintIdentity } from './helpers.js';

const vectors = loadVectors();
const vec = (name: string) => vectors.cases.find((c) => c.name === name)!;
const vectorDeal = vec('deal-valid');
const vectorListing = vec('listing-ref-valid');

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-store-'));
  store = openStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const indexPath = () => join(dir, '.data', 'index.sqlite');
const keysDir = () => join(dir, '.data', 'keys');

/** Seed the trust ring with the vector identities (test-vectors are the authoritative signers). */
function trustVectorIdentities(s: Store) {
  for (const [agentId, ident] of Object.entries(vectors.identities)) {
    s.saveKey(agentId, ident.seed);
  }
}

function countEvents(tradeId: string): number {
  const db = new Database(indexPath(), { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM events WHERE trade_id = ?').get(tradeId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function sellerEvent(tradeId: string, eventType: string, i: number) {
  return makeEvent({
    tradeId, eventType, actor: 'agent_seller', secretKey: vectors.identities.agent_seller.seed,
    occurredAt: at('2026-08-22T00:00:00Z', i),
  });
}

function buyerEvent(tradeId: string, eventType: string, i: number) {
  return makeEvent({
    tradeId, eventType, actor: 'agent_buyer', secretKey: vectors.identities.agent_buyer.seed,
    occurredAt: at('2026-08-22T00:00:00Z', i),
  });
}

describe('M3 acceptance 1: putObject rejects files that fail verifyFile', () => {
  it('accepts the valid DEAL and LISTING_REF vectors, returning the declared object_id', () => {
    trustVectorIdentities(store);
    expect(store.putObject(vectorDeal.file)).toBe(vectorDeal.object_id);
    expect(store.putObject(vectorListing.file)).toBe(vectorListing.object_id);
    // idempotent re-put
    expect(store.putObject(vectorDeal.file)).toBe(vectorDeal.object_id);
    // round-trips through getObject (fact file is the source of truth)
    expect(store.getObject(vectorDeal.object_id!)).toEqual(vectorDeal.file);
    expect(store.getObject(vectorListing.object_id!)).toEqual(vectorListing.file);
  });

  it('rejects the tampered vectors (改 body 不改 hash / 改 body 重算 hash)', () => {
    trustVectorIdentities(store);
    for (const name of ['deal-tampered-body-keep-hash', 'deal-tampered-body-rehash']) {
      const c = vec(name);
      expect(() => store.putObject(c.file), name).toThrow(/verification failed/);
    }
  });

  it('rejects a file signed by an unknown signer (fail:unknown_signer)', () => {
    // only buyer/seller are in the ring; a fresh identity is unknown
    trustVectorIdentities(store);
    const stranger = mintIdentity();
    const event = makeEvent({
      tradeId: 't-unknown', eventType: 'DEAL_SIGNED', actor: 'stranger', secretKey: stranger.secretKey,
      occurredAt: at('2026-08-22T00:00:00Z'),
    });
    expect(() => store.putObject(event)).toThrow(/verification failed \(fail:unknown_signer\)/);
  });

  it('rejects a file with no signatures', () => {
    trustVectorIdentities(store);
    const unsigned = buildObject('TRADE_EVENT', {
      event_id: 'e-unsigned', trade_id: 't-unsigned', event_type: 'DEAL_SIGNED', actor: 'agent_buyer',
      occurred_at: at('2026-08-22T00:00:00Z'),
    });
    expect(() => store.putObject(unsigned)).toThrow(/verification failed/);
  });
});

describe('M3 acceptance 2: rebuildIndex after physically deleting index.sqlite', () => {
  it('getObject / stateOf are identical to the pre-deletion store', () => {
    trustVectorIdentities(store);

    // two trades at different lifecycle points + non-event objects
    const dealId = store.putObject(vectorDeal.file);
    store.putObject(vectorListing.file);

    const t1 = 'trade-rebuild-1';
    const t2 = 'trade-rebuild-2';
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'COMPLETED'] as const)
      .forEach((et, i) => { store.applyEvent(t1, sellerEvent(t1, et, i)); });
    // t2: disputed then resolved mid-chain (pre-dispute state must survive)
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'DISPUTED', 'RESOLVED'] as const)
      .forEach((et, i) => { store.applyEvent(t2, buyerEvent(t2, et, i)); });

    const before = {
      deal: JSON.stringify(store.getObject(dealId!)),
      listing: JSON.stringify(store.getObject(vectorListing.object_id!)),
      t1: store.stateOf(t1),
      t2: store.stateOf(t2),
      eventsT1: countEvents(t1),
      eventsT2: countEvents(t2),
    };
    expect(before.t1).toBe('COMPLETED');
    expect(before.t2).toBe('PAYMENT_CONFIRMED'); // RESOLVED restored pre-dispute state

    // physically delete the index — the fact files must be the only thing left
    rmSync(indexPath(), { force: true });

    store.rebuildIndex();

    expect(JSON.stringify(store.getObject(dealId!))).toBe(before.deal);
    expect(JSON.stringify(store.getObject(vectorListing.object_id!))).toBe(before.listing);
    expect(store.stateOf(t1)).toBe(before.t1);
    expect(store.stateOf(t2)).toBe(before.t2);
    expect(countEvents(t1)).toBe(before.eventsT1);
    expect(countEvents(t2)).toBe(before.eventsT2);

    // the recreated index.sqlite must be a real, durable file
    expect(statSync(indexPath()).isFile()).toBe(true);
  });

  it('survives close+reopen after rebuild (index is a real file, not an unlinked inode)', () => {
    trustVectorIdentities(store);
    const t = 'trade-reopen';
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'FULFILLING'] as const)
      .forEach((et, i) => { store.applyEvent(t, sellerEvent(t, et, i)); });
    rmSync(indexPath(), { force: true });
    store.rebuildIndex();
    expect(store.stateOf(t)).toBe('FULFILLING');

    store.close();
    store = openStore(dir);
    expect(store.stateOf(t)).toBe('FULFILLING');
  });
});

describe('M3 acceptance 3: event log is append-only', () => {
  it('re-applying the same event is idempotent: state unchanged, no duplicate rows', () => {
    trustVectorIdentities(store);
    const t = 'trade-idem';
    const signed = buyerEvent(t, 'DEAL_SIGNED', 0);

    expect(store.applyEvent(t, signed)).toBe('AGREED');
    expect(countEvents(t)).toBe(1);

    // replay the identical event after advancing the chain — still a no-op
    expect(store.applyEvent(t, sellerEvent(t, 'PAYMENT_REQUESTED', 1))).toBe('PAYMENT_PENDING');
    expect(store.applyEvent(t, signed)).toBe('PAYMENT_PENDING'); // no state change
    expect(countEvents(t)).toBe(2); // no duplicate rows
  });

  it('a *different* DEAL_SIGNED event for an existing trade is rejected (only initial)', () => {
    trustVectorIdentities(store);
    const t = 'trade-second-deal';
    store.applyEvent(t, buyerEvent(t, 'DEAL_SIGNED', 0));
    expect(() => store.applyEvent(t, sellerEvent(t, 'DEAL_SIGNED', 1))).toThrow(/only allowed as the initial event/);
    expect(countEvents(t)).toBe(1);
  });

  it('exposes exactly the card surface: no update/delete entry points', () => {
    expect(Object.keys(store).sort()).toEqual(
      [
        'applyEvent',
        'close',
        'getKey',
        'getObject',
        'getPublicKey',
        'putObject',
        'rebuildIndex',
        'saveKey',
        'savePeerKey',
        'stateOf',
      ],
    );
  });
});

describe('M3 acceptance 4: state machine', () => {
  it('legal chain DEAL_SIGNED → … → COMPLETED passes every step', () => {
    trustVectorIdentities(store);
    const t = 'trade-chain';
    const steps: Array<[string, TradeState]> = [
      ['DEAL_SIGNED', 'AGREED'],
      ['PAYMENT_REQUESTED', 'PAYMENT_PENDING'],
      ['PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED'],
      ['FULFILLING', 'FULFILLING'],
      ['SHIPPED', 'SHIPPED'],
      ['DELIVERED', 'DELIVERED'],
      ['COMPLETED', 'COMPLETED'],
    ];
    steps.forEach(([et, expected], i) => {
      const event = sellerEvent(t, et, i);
      const state = store.applyEvent(t, event);
      expect(state).toBe(expected);
      expect(store.stateOf(t)).toBe(expected);
      // every applied event is persisted as an immutable fact file
      expect(store.getObject(objectId(event))).toEqual(event);
    });
  });

  it('PAYMENT_CONFIRMED then direct COMPLETED must throw and persist nothing', () => {
    trustVectorIdentities(store);
    const t = 'trade-skip';
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED'] as const)
      .forEach((et, i) => { store.applyEvent(t, sellerEvent(t, et, i)); });

    const completed = sellerEvent(t, 'COMPLETED', 3);
    expect(() => store.applyEvent(t, completed)).toThrow(/requires state DELIVERED/);
    expect(store.stateOf(t)).toBe('PAYMENT_CONFIRMED'); // unchanged
    expect(countEvents(t)).toBe(3); // COMPLETED not appended
    expect(store.getObject(objectId(completed))).toBeUndefined(); // fact file not written
  });

  it('ESCROWED is an alternative to PAYMENT_CONFIRMED', () => {
    trustVectorIdentities(store);
    const t = 'trade-escrow';
    store.applyEvent(t, buyerEvent(t, 'DEAL_SIGNED', 0));
    store.applyEvent(t, sellerEvent(t, 'PAYMENT_REQUESTED', 1));
    expect(store.applyEvent(t, buyerEvent(t, 'ESCROWED', 2))).toBe('PAYMENT_CONFIRMED');
  });

  it('DISPUTED → RESOLVED restores the pre-dispute state and the chain continues', () => {
    trustVectorIdentities(store);
    const t = 'trade-dispute';
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED'] as const)
      .forEach((et, i) => { store.applyEvent(t, sellerEvent(t, et, i)); });
    expect(store.applyEvent(t, buyerEvent(t, 'DISPUTED', 6))).toBe('DISPUTED');
    expect(store.applyEvent(t, sellerEvent(t, 'RESOLVED', 7))).toBe('DELIVERED');
    // chain continues from the restored state
    expect(store.applyEvent(t, sellerEvent(t, 'COMPLETED', 8))).toBe('COMPLETED');
  });

  it('RESOLVED without DISPUTED throws', () => {
    trustVectorIdentities(store);
    const t = 'trade-resolved-no-dispute';
    store.applyEvent(t, buyerEvent(t, 'DEAL_SIGNED', 0));
    expect(() => store.applyEvent(t, buyerEvent(t, 'RESOLVED', 1))).toThrow(/requires state DISPUTED/);
  });

  it('COMPLETED and CANCELLED are terminal: any later event throws', () => {
    trustVectorIdentities(store);
    // completed trade
    const a = 'trade-terminal-a';
    (['DEAL_SIGNED', 'PAYMENT_REQUESTED', 'PAYMENT_CONFIRMED', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'COMPLETED'] as const)
      .forEach((et, i) => { store.applyEvent(a, sellerEvent(a, et, i)); });
    expect(() => store.applyEvent(a, buyerEvent(a, 'DISPUTED', 7))).toThrow(/terminal state COMPLETED/);
    expect(() => store.applyEvent(a, buyerEvent(a, 'CANCELLED', 8))).toThrow(/terminal state COMPLETED/);

    // cancelled trade (mid-chain cancel is allowed; nothing after it)
    const b = 'trade-terminal-b';
    store.applyEvent(b, buyerEvent(b, 'DEAL_SIGNED', 0));
    store.applyEvent(b, sellerEvent(b, 'PAYMENT_REQUESTED', 1));
    expect(store.applyEvent(b, buyerEvent(b, 'CANCELLED', 2))).toBe('CANCELLED');
    expect(() => store.applyEvent(b, sellerEvent(b, 'DELIVERED', 3))).toThrow(/terminal state CANCELLED/);
    expect(store.stateOf(b)).toBe('CANCELLED');
  });

  it('rejects an event whose body trade_id mismatches the argument', () => {
    trustVectorIdentities(store);
    const event = buyerEvent('other-trade', 'DEAL_SIGNED', 0);
    expect(() => store.applyEvent('this-trade', event)).toThrow(/does not match argument/);
  });

  it('stateOf is undefined for a trade with no events', () => {
    trustVectorIdentities(store);
    expect(store.stateOf('never-seen')).toBeUndefined();
  });
});

describe('M3 acceptance 5: keys/ directory and key file permissions', () => {
  it('keys/ is 0700 and the secret key file is 0600 (fs.stat)', () => {
    trustVectorIdentities(store);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(keysDir())).toBe(0o700);
    expect(mode(join(keysDir(), encodeURIComponent('agent_buyer') + '.key'))).toBe(0o600);
    expect(store.getKey('agent_buyer')).toBe(vectors.identities.agent_buyer.seed);
    expect(store.getKey('nobody')).toBeUndefined();
  });

  it('the trust ring survives close/reopen (keys loaded from disk)', () => {
    trustVectorIdentities(store);
    const t = 'trade-ring-reopen';
    store.applyEvent(t, buyerEvent(t, 'DEAL_SIGNED', 0));
    store.close();
    store = openStore(dir);
    // still verifies: public key was re-derived from the saved seed on open
    expect(store.applyEvent(t, sellerEvent(t, 'PAYMENT_REQUESTED', 1))).toBe('PAYMENT_PENDING');
    expect(store.getKey('agent_seller')).toBe(vectors.identities.agent_seller.seed);
  });

  it('peer public keys persist without copying a secret seed (TOFU)', () => {
    const publicKey = publicKeyFromSeed(vectors.identities.agent_seller.seed);
    store.savePeerKey('agent_seller', publicKey);
    expect(store.getKey('agent_seller')).toBeUndefined();
    expect(store.getPublicKey('agent_seller')).toBe(publicKey);
    expect(store.putObject(vectorListing.file)).toBe(vectorListing.object_id);

    store.close();
    store = openStore(dir);
    expect(store.getPublicKey('agent_seller')).toBe(publicKey);
    expect(() => store.savePeerKey('agent_seller', publicKeyFromSeed(vectors.identities.agent_buyer.seed))).toThrow(
      /key conflict/,
    );
  });
});
