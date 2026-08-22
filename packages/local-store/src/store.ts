/**
 * @agent-trade/local-store — .data/ layout, SQLite index, trade state machine,
 * append-only event log (module card M3).
 *
 * Design principles (card):
 * - Signed fact files under `.data/objects/sha256/<hex>.json` are the single
 *   source of truth; `index.sqlite` is a disposable, fully re-derivable index.
 * - `getObject` reads the fact file directly (never the index), so it stays
 *   correct even while `index.sqlite` is missing.
 * - `rebuildIndex()` closes and recreates the database, then replays every
 *   TRADE_EVENT fact file in deterministic order (occurred_at, event_id),
 *   so the result is identical whether or not the previous file was deleted.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { publicKeyFromSeed } from '@agent-trade/identity';
import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile, VerifyResult } from '@agent-trade/signed-files';

import { transition } from './state.js';
import type { EventType, TradeState } from './state.js';

const DATA_DIR = '.data';
// layout is <dir>/.data/objects/sha256/<hex>.json, <dir>/.data/keys/, <dir>/.data/index.sqlite
const OBJECTS_REL = join('objects', 'sha256');
const KEYS_REL = 'keys';
const INDEX_REL = 'index.sqlite';

const OBJECT_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** TRADE_EVENT body as guaranteed by the schema (verified before use). */
interface TradeEventBody {
  event_id: string;
  trade_id: string;
  event_type: EventType;
  actor: string;
  occurred_at: string;
  evidence?: unknown;
  message?: string;
}

export interface Store {
  /** Verify first; throws unless `verifyFile` returns 'valid'. Idempotent. Returns object_id. */
  putObject(file: SignedFile): string;
  /** Read the immutable fact file; undefined when absent. */
  getObject(objectId: string): SignedFile | undefined;
  /** Close, recreate index.sqlite and fully re-derive it from objects/. */
  rebuildIndex(): void;
  /** Persist a secret key under keys/ (file mode 0600) and trust its public key. */
  saveKey(agentId: string, secretKey: string): void;
  /** Read a previously saved secret key; undefined when absent. */
  getKey(agentId: string): string | undefined;
  /** Verify the event signature, apply the state machine, append to the event log. Throws on invalid signature or transition. */
  applyEvent(tradeId: string, event: SignedFile): TradeState;
  /** Current state of a trade; undefined when no event was ever applied. */
  stateOf(tradeId: string): TradeState | undefined;
  close(): void;
}

interface EventRow {
  trade_id: string;
  event_id: string;
  object_id: string;
  event_type: string;
  actor: string;
  occurred_at: string;
  body: string;
}

interface TradeRow {
  trade_id: string;
  state: TradeState;
  pre_dispute_state: string | null;
}

function assertObjectId(id: string): void {
  if (!OBJECT_ID_RE.test(id)) {
    throw new Error(`invalid object_id: ${JSON.stringify(id)} (expected "sha256:" + 64 lowercase hex)`);
  }
}

function hexPart(id: string): string {
  assertObjectId(id);
  return id.slice('sha256:'.length);
}

function factPath(objectsDir: string, id: string): string {
  return join(objectsDir, hexPart(id) + '.json');
}

function writeFact(objectsDir: string, id: string, file: SignedFile): void {
  const target = factPath(objectsDir, id);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  renameSync(tmp, target); // atomic replace; idempotent for identical content
}

function readFact(objectsDir: string, id: string): SignedFile | undefined {
  const target = factPath(objectsDir, id);
  if (!existsSync(target)) return undefined;
  return JSON.parse(readFileSync(target, 'utf8')) as SignedFile;
}

function keyFileName(agentId: string): string {
  return encodeURIComponent(agentId) + '.key';
}

function loadKeyRing(keysDir: string, keyRing: Map<string, string>): void {
  for (const name of readdirSync(keysDir)) {
    if (!name.endsWith('.key')) continue;
    const agentId = decodeURIComponent(name.slice(0, -'.key'.length));
    const secretKey = readFileSync(join(keysDir, name), 'utf8').trim();
    keyRing.set(agentId, publicKeyFromSeed(secretKey));
  }
}

function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      trade_id    TEXT NOT NULL,
      event_id    TEXT NOT NULL,
      object_id   TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      actor       TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      body        TEXT NOT NULL,
      PRIMARY KEY (trade_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS events_by_trade ON events(trade_id, occurred_at, event_id);
    CREATE TABLE IF NOT EXISTS trades (
      trade_id          TEXT PRIMARY KEY,
      state             TEXT NOT NULL,
      pre_dispute_state TEXT
    );
  `);
  return db;
}

export function openStore(dir: string): Store {
  const root = join(dir, DATA_DIR);
  const objectsDir = join(root, OBJECTS_REL);
  const keysDir = join(root, KEYS_REL);
  const indexPath = join(root, INDEX_REL);

  mkdirSync(objectsDir, { recursive: true });
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  chmodSync(keysDir, 0o700); // exact mode regardless of umask

  // Trust ring: public keys derived from the saved secret keys. verifyFile
  // resolves signers through this ring (test vectors' identities are loaded
  // via saveKey, exactly as the module card prescribes).
  const keyRing = new Map<string, string>();
  loadKeyRing(keysDir, keyRing);
  const resolveKey = (signer: string): string | undefined => keyRing.get(signer);

  let db = openDb(indexPath);

  const putObjectImpl = (file: SignedFile): string => {
    const result: VerifyResult = verifyFile(file, resolveKey);
    if (result !== 'valid') {
      throw new Error(`putObject: verification failed (${result})`);
    }
    const id = objectId(file);
    writeFact(objectsDir, id, file);
    return id;
  };

  const currentState = (tradeId: string): TradeState | undefined => {
    const row = db.prepare('SELECT state FROM trades WHERE trade_id = ?').get(tradeId) as Pick<TradeRow, 'state'> | undefined;
    return row?.state;
  };

  const store: Store = {
    putObject(file: SignedFile): string {
      return putObjectImpl(file);
    },

    getObject(id: string): SignedFile | undefined {
      return readFact(objectsDir, id);
    },

    rebuildIndex(): void {
      // Drop the old handle and the file entirely: rebuilding must produce the
      // same index whether or not index.sqlite was physically deleted (a
      // stale better-sqlite3 handle would keep writing to an unlinked inode).
      db.close();
      rmSync(indexPath, { force: true });
      for (const suffix of ['-journal', '-wal', '-shm']) {
        rmSync(indexPath + suffix, { force: true });
      }
      db = openDb(indexPath);

      // 1. collect every TRADE_EVENT fact file
      const events: EventRow[] = [];
      for (const name of readdirSync(objectsDir)) {
        if (!name.endsWith('.json')) continue;
        const file = JSON.parse(readFileSync(join(objectsDir, name), 'utf8')) as SignedFile;
        if (file.object_type !== 'TRADE_EVENT') continue;
        const body = file.body as TradeEventBody;
        events.push({
          trade_id: body.trade_id,
          event_id: body.event_id,
          object_id: objectId(file),
          event_type: body.event_type,
          actor: body.actor,
          occurred_at: body.occurred_at,
          body: JSON.stringify(body),
        });
      }

      // 2. deterministic replay order: occurred_at, then event_id (uuid v7 is
      //    time-ordered, so ties are effectively impossible for well-formed
      //    trades; this matches the order a valid chain was applied in).
      events.sort((a, b) =>
        a.occurred_at < b.occurred_at ? -1 :
        a.occurred_at > b.occurred_at ? 1 :
        a.event_id < b.event_id ? -1 :
        a.event_id > b.event_id ? 1 : 0,
      );

      // 3. append-only event log (INSERT OR IGNORE keeps it idempotent)
      const insertEvent = db.prepare(
        `INSERT OR IGNORE INTO events (trade_id, event_id, object_id, event_type, actor, occurred_at, body)
         VALUES (@trade_id, @event_id, @object_id, @event_type, @actor, @occurred_at, @body)`,
      );
      const upsertTrade = db.prepare(
        `INSERT INTO trades (trade_id, state, pre_dispute_state) VALUES (@trade_id, @state, @pre_dispute_state)
         ON CONFLICT(trade_id) DO UPDATE SET
           state = excluded.state,
           pre_dispute_state = excluded.pre_dispute_state`,
      );

      // 4. replay each trade through the state machine. A chain that fails
      //    replay means the fact files were never validly applied (or were
      //    tampered with) — fail loudly instead of guessing.
      const byTrade = new Map<string, EventRow[]>();
      for (const ev of events) {
        insertEvent.run(ev);
        let list = byTrade.get(ev.trade_id);
        if (list === undefined) {
          list = [];
          byTrade.set(ev.trade_id, list);
        }
        list.push(ev);
      }
      for (const [tradeId, evs] of byTrade) {
        let current: TradeState | undefined;
        let preDispute: TradeState | null = null;
        for (const ev of evs) {
          const next = transition(current, preDispute, ev.event_type as EventType);
          current = next.state;
          preDispute = next.preDispute;
        }
        upsertTrade.run({ trade_id: tradeId, state: current, pre_dispute_state: preDispute });
      }
    },

    saveKey(agentId: string, secretKey: string): void {
      const path = join(keysDir, keyFileName(agentId));
      writeFileSync(path, secretKey + '\n', { mode: 0o600 });
      chmodSync(path, 0o600); // exact mode regardless of umask
      keyRing.set(agentId, publicKeyFromSeed(secretKey));
    },

    getKey(agentId: string): string | undefined {
      const path = join(keysDir, keyFileName(agentId));
      if (!existsSync(path)) return undefined;
      return readFileSync(path, 'utf8').trim();
    },

    applyEvent(tradeId: string, event: SignedFile): TradeState {
      const result: VerifyResult = verifyFile(event, resolveKey);
      if (result !== 'valid') {
        throw new Error(`applyEvent: verification failed (${result})`);
      }
      const body = event.body as TradeEventBody;
      if (body.trade_id !== tradeId) {
        throw new Error(
          `applyEvent: event body trade_id ${JSON.stringify(body.trade_id)} does not match argument ${JSON.stringify(tradeId)}`,
        );
      }

      // Append-only idempotency: the same (trade_id, event_id) already applied
      // is a no-op — no extra row, no state change, even though replaying the
      // transition from the current state would now be "illegal".
      const dup = db.prepare('SELECT 1 FROM events WHERE trade_id = ? AND event_id = ?').get(tradeId, body.event_id);
      if (dup !== undefined) {
        return currentState(tradeId) as TradeState;
      }

      // Validate the transition BEFORE persisting anything.
      const row = db.prepare('SELECT state, pre_dispute_state FROM trades WHERE trade_id = ?').get(tradeId) as TradeRow | undefined;
      const preDispute = (row?.pre_dispute_state ?? null) as TradeState | null;
      const next = transition(row?.state, preDispute, body.event_type);

      // Persist the fact file first (source of truth), then the index rows.
      putObjectImpl(event);
      db.prepare(
        `INSERT OR IGNORE INTO events (trade_id, event_id, object_id, event_type, actor, occurred_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(tradeId, body.event_id, objectId(event), body.event_type, body.actor, body.occurred_at, JSON.stringify(body));
      db.prepare(
        `INSERT INTO trades (trade_id, state, pre_dispute_state) VALUES (?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           state = excluded.state,
           pre_dispute_state = excluded.pre_dispute_state`,
      ).run(tradeId, next.state, next.preDispute);

      return next.state;
    },

    stateOf(tradeId: string): TradeState | undefined {
      return currentState(tradeId);
    },

    close(): void {
      db.close();
    },
  };

  return store;
}
