/**
 * Module M7 — human-task adapter types (module card M7, protocol §4/§7.2).
 * `HUMAN_TASK` is a local execution interface: a model opens a task, a human
 * performs it and reports a result, and the model mints a signed TRADE_EVENT
 * from the completed task. It is not part of the market-core protocol.
 */

import type { SignedFile } from '@agent-trade/signed-files';

export type TaskType = 'PAY' | 'PURCHASE' | 'INSPECT' | 'PRODUCE' | 'PICKUP' | 'SHIP' | 'RECEIVE';

export type TaskStatus = 'PENDING' | 'DONE' | 'CANCELLED';

export interface HumanTask {
  task_id: string;
  trade_id: string;
  task_type: TaskType;
  instructions: string;
  deadline?: string;
  required_output?: string[];
  status: TaskStatus;
  result?: Record<string, unknown>;
}

export interface HumanTaskStore {
  /** Open a PENDING task; returns its task_id (uuid v7). Persists to .data/tasks/ and the index.sqlite mirror. */
  create(t: Omit<HumanTask, 'task_id' | 'status'>): string;
  get(taskId: string): HumanTask | undefined;
  list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[];
  /** PENDING → DONE, recording the human result. Throws unless the task is PENDING. */
  complete(taskId: string, result: Record<string, unknown>): void;
  /** PENDING → CANCELLED. Throws unless the task is PENDING. */
  cancel(taskId: string): void;
  /**
   * Only DONE tasks may emit an event. Builds a single-signed TRADE_EVENT whose
   * body.evidence carries the task result, verifies + applies it via the store
   * state machine, and returns the signed file. The signer's public key must be
   * registered in the store's trust ring (store.saveKey) beforehand.
   */
  toEvent(taskId: string, eventType: string, ctx: { agentId: string; secretKey: string }): SignedFile;
}
