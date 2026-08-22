/**
 * HumanTaskStore — pure structural contract shared with module M7
 * (adapters/human-task).
 *
 * M7 is being developed in parallel; this package must NOT import its source.
 * The interface below is declared locally as a type contract only: TypeScript
 * structural typing makes a runtime M7 `createHumanTaskStore(store)` instance
 * assignable to it as long as the member signatures match, and the caller
 * injects the instance into `createManualSettlementAdapter({ taskStore })`.
 *
 * Copy of the interface block of docs/module-cards/M7-human-task.md.
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
  /** Create a task; returns task_id (uuid v7 per M7 card). */
  create(t: Omit<HumanTask, 'task_id' | 'status'>): string;
  get(taskId: string): HumanTask | undefined;
  list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[];
  /** PENDING → DONE with the recorded result. */
  complete(taskId: string, result: Record<string, unknown>): void;
  /** PENDING → CANCELLED. */
  cancel(taskId: string): void;
  /** Sign a TRADE_EVENT from a DONE task's result and apply it (M7-owned; not used by M6). */
  toEvent(taskId: string, eventType: string, ctx: { agentId: string; secretKey: string }): SignedFile;
}
