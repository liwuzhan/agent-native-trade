/**
 * Module M7 — human-task store over a local-store (module card M7).
 *
 * Data layout: an extension of the M3 `.data/` layout, declared on top of the
 * M3 card:
 *
 *   .data/
 *   ├── objects/sha256/<hash>.json   # M3: immutable signed fact files
 *   ├── keys/                        # M3: 0700 dir, 0600 key files
 *   ├── index.sqlite                 # M3: disposable index; M7 adds a `tasks` table
 *   └── tasks/<task_id>.json         # M7: task files (source of truth)
 *
 * Exactly like M3, the task JSON files under `.data/tasks/` are the source of
 * truth and the `tasks` table in index.sqlite is a disposable, fully
 * re-derivable mirror: `list()` always reads the files and re-syncs the mirror,
 * so deleting/recreating index.sqlite (store.rebuildIndex()) never loses tasks.
 *
 * The mirror is written with the built-in `node:sqlite` (zero extra
 * dependencies; the adapter itself stays pure ESM — no better-sqlite3, no
 * esModuleInterop). Mirror writes are best-effort: a locked or missing index
 * must never break task CRUD.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { EventType, Store } from '@agent-trade/local-store';
import { addSignature, buildObject } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import type { HumanTask, HumanTaskStore, TaskStatus, TaskType } from './types.js';
import { UUIDV7_RE, uuidv7 } from './uuid.js';

const TASK_TYPES: readonly TaskType[] = ['PAY', 'PURCHASE', 'INSPECT', 'PRODUCE', 'PICKUP', 'SHIP', 'RECEIVE'];

/** TRADE_EVENT body.event_type enum (protocol schema; mirrors local-store's EventType). */
const EVENT_TYPES: readonly EventType[] = [
  'DEAL_SIGNED',
  'PAYMENT_REQUESTED',
  'PAYMENT_CONFIRMED',
  'ESCROWED',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'DISPUTED',
  'RESOLVED',
  'CANCELLED',
];

const TASKS_REL = join('.data', 'tasks');
const INDEX_REL = join('.data', 'index.sqlite');

export interface HumanTaskStoreOptions {
  /**
   * The directory that was passed to openStore(). Task files live under
   * `<dir>/.data/tasks/` and the mirror under `<dir>/.data/index.sqlite`.
   * Defaults to process.cwd() — always pass the store's dir so the tasks land
   * in the same `.data/` root as the store.
   */
  dir?: string;
}

export function createHumanTaskStore(store: Store, opts: HumanTaskStoreOptions = {}): HumanTaskStore {
  const tasksDir = join(opts.dir ?? process.cwd(), TASKS_REL);
  const indexPath = join(opts.dir ?? process.cwd(), INDEX_REL);
  mkdirSync(tasksDir, { recursive: true });

  // ---- task_id safety: ids are uuid v7 by construction; any caller-supplied
  // id is validated before it is ever interpolated into a filesystem path.
  function assertTaskId(taskId: string): void {
    if (typeof taskId !== 'string' || !UUIDV7_RE.test(taskId)) {
      throw new Error(`invalid task_id ${JSON.stringify(taskId)} (expected uuid v7)`);
    }
  }

  function taskPath(taskId: string): string {
    return join(tasksDir, taskId + '.json');
  }

  function assertTaskShape(value: unknown): asserts value is HumanTask {
    const t = value as HumanTask;
    if (
      typeof t !== 'object' ||
      t === null ||
      typeof t.task_id !== 'string' ||
      typeof t.trade_id !== 'string' ||
      typeof t.task_type !== 'string' ||
      typeof t.instructions !== 'string' ||
      typeof t.status !== 'string'
    ) {
      throw new Error('corrupt task file: missing required fields');
    }
  }

  function writeTaskFile(task: HumanTask): void {
    const target = taskPath(task.task_id);
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(task, null, 2) + '\n', 'utf8');
    renameSync(tmp, target); // atomic replace
  }

  function readTaskFile(taskId: string): HumanTask {
    const parsed: unknown = JSON.parse(readFileSync(taskPath(taskId), 'utf8'));
    assertTaskShape(parsed);
    return parsed;
  }

  // ---- index.sqlite tasks mirror (disposable; best-effort; node:sqlite)
  function syncTasksMirror(tasks: HumanTask[]): void {
    try {
      const db = new DatabaseSync(indexPath);
      try {
        db.exec('PRAGMA busy_timeout = 5000;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS tasks (
            task_id  TEXT PRIMARY KEY,
            trade_id TEXT NOT NULL,
            status   TEXT NOT NULL,
            task     TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS tasks_by_trade  ON tasks(trade_id);
        `);
        const upsert = db.prepare(
          `INSERT INTO tasks (task_id, trade_id, status, task) VALUES (?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             trade_id = excluded.trade_id,
             status   = excluded.status,
             task     = excluded.task`,
        );
        for (const task of tasks) {
          upsert.run(task.task_id, task.trade_id, task.status, JSON.stringify(task));
        }
      } finally {
        db.close();
      }
    } catch {
      // index.sqlite is a disposable mirror; task files are the source of
      // truth. Failures (lock contention, index mid-rebuild, node:sqlite
      // quirks) degrade to files-only rather than breaking task CRUD.
    }
  }

  function getTask(taskId: string): HumanTask | undefined {
    assertTaskId(taskId);
    const path = taskPath(taskId);
    if (!existsSync(path)) return undefined;
    return readTaskFile(taskId);
  }

  function readAllTasks(): HumanTask[] {
    const tasks: HumanTask[] = [];
    for (const name of readdirSync(tasksDir)) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -'.json'.length);
      try {
        tasks.push(readTaskFile(taskId));
      } catch {
        // a corrupt file is skipped by list() rather than failing the whole
        // store; get() by id still surfaces the error directly.
      }
    }
    // uuid v7 is time-ordered, so sorting by task_id is creation order.
    tasks.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
    return tasks;
  }

  function validateCreateInput(t: Omit<HumanTask, 'task_id' | 'status'>): void {
    if (!TASK_TYPES.includes(t.task_type)) {
      throw new TypeError(`create: invalid task_type ${JSON.stringify(t.task_type)} (expected one of ${TASK_TYPES.join(', ')})`);
    }
    if (typeof t.trade_id !== 'string' || t.trade_id.length === 0) {
      throw new TypeError('create: trade_id must be a non-empty string');
    }
    if (typeof t.instructions !== 'string' || t.instructions.length === 0) {
      throw new TypeError('create: instructions must be a non-empty string');
    }
    if (t.deadline !== undefined && typeof t.deadline !== 'string') {
      throw new TypeError('create: deadline must be a string');
    }
    if (t.required_output !== undefined) {
      if (!Array.isArray(t.required_output) || t.required_output.some((r) => typeof r !== 'string')) {
        throw new TypeError('create: required_output must be an array of strings');
      }
    }
  }

  function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`expected a plain object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    }
  }

  return {
    create(t): string {
      validateCreateInput(t);
      const task: HumanTask = {
        task_id: uuidv7(),
        trade_id: t.trade_id,
        task_type: t.task_type,
        instructions: t.instructions,
        status: 'PENDING',
        ...(t.deadline !== undefined ? { deadline: t.deadline } : {}),
        ...(t.required_output !== undefined ? { required_output: t.required_output } : {}),
      };
      writeTaskFile(task);
      syncTasksMirror([task]);
      return task.task_id;
    },

    get(taskId: string): HumanTask | undefined {
      return getTask(taskId);
    },

    list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[] {
      const tasks = readAllTasks();
      const out = tasks.filter((t) => {
        if (filter?.status !== undefined && t.status !== filter.status) return false;
        if (filter?.tradeId !== undefined && t.trade_id !== filter.tradeId) return false;
        return true;
      });
      // keep the disposable mirror a faithful copy of ALL task files — also
      // re-creates the tasks table after store.rebuildIndex() wiped index.sqlite,
      // regardless of whether this call applied a filter.
      syncTasksMirror(tasks);
      return out;
    },

    complete(taskId: string, result: Record<string, unknown>): void {
      assertPlainObject(result);
      const task = getTask(taskId);
      if (task === undefined) throw new Error(`complete: unknown task ${JSON.stringify(taskId)}`);
      if (task.status !== 'PENDING') {
        throw new Error(`complete: task ${task.task_id} is ${task.status}; only PENDING tasks can be completed`);
      }
      const updated: HumanTask = { ...task, status: 'DONE', result };
      writeTaskFile(updated);
      syncTasksMirror([updated]);
    },

    cancel(taskId: string): void {
      const task = getTask(taskId);
      if (task === undefined) throw new Error(`cancel: unknown task ${JSON.stringify(taskId)}`);
      if (task.status !== 'PENDING') {
        throw new Error(`cancel: task ${task.task_id} is ${task.status}; only PENDING tasks can be cancelled`);
      }
      const updated: HumanTask = { ...task, status: 'CANCELLED' };
      writeTaskFile(updated);
      syncTasksMirror([updated]);
    },

    toEvent(taskId: string, eventType: string, ctx: { agentId: string; secretKey: string }): SignedFile {
      const task = getTask(taskId);
      if (task === undefined) throw new Error(`toEvent: unknown task ${JSON.stringify(taskId)}`);
      if (task.status !== 'DONE') {
        throw new Error(`toEvent: task ${task.task_id} is ${task.status}; only DONE tasks can emit events`);
      }
      if (!EVENT_TYPES.includes(eventType as EventType)) {
        throw new Error(`toEvent: invalid event_type ${JSON.stringify(eventType)} (expected one of ${EVENT_TYPES.join(', ')})`);
      }

      const evidence: Record<string, unknown> = { task_id: task.task_id, task_type: task.task_type };
      if (task.result !== undefined) evidence.result = task.result;

      const body = {
        event_id: uuidv7(),
        trade_id: task.trade_id,
        event_type: eventType,
        actor: ctx.agentId,
        occurred_at: new Date().toISOString(),
        evidence,
        message: `human task ${task.task_id} (${task.task_type}) completed: ${eventType}`,
      };
      const event = addSignature(buildObject('TRADE_EVENT', body), ctx.agentId, ctx.secretKey);

      // applyEvent verifies the signature against the store's trust ring and
      // the state machine transition, then persists the fact file; it throws
      // on any failure (unknown signer / invalid transition).
      store.applyEvent(task.trade_id, event);
      return event;
    },
  };
}
