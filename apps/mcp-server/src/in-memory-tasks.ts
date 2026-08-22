/**
 * In-memory HumanTaskStore for the `manual-settlement` adapter (module M6
 * structural contract; M7's real store is injected in deployments that have
 * it). Tasks live only for the process lifetime — the voucher adapter is the
 * CI/default path; manual-settlement is exercised here by completing tasks
 * directly against the app context.
 */

import { randomBytes } from 'node:crypto';

import type { SignedFile } from '@agent-trade/signed-files';
import type { HumanTask, HumanTaskStore, TaskStatus, TaskType } from '@agent-trade/settlement';

function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  const ms = BigInt(Math.trunc(now));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const rand = randomBytes(10);
  bytes.set(rand, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class InMemoryHumanTaskStore implements HumanTaskStore {
  private readonly tasks = new Map<string, HumanTask>();

  create(t: Omit<HumanTask, 'task_id' | 'status'>): string {
    const taskId = uuidV7();
    this.tasks.set(taskId, { ...t, task_id: taskId, status: 'PENDING' });
    return taskId;
  }

  get(taskId: string): HumanTask | undefined {
    return this.tasks.get(taskId);
  }

  list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[] {
    const all = [...this.tasks.values()];
    if (filter === undefined) return all;
    return all.filter(
      (t) =>
        (filter.status === undefined || t.status === filter.status) &&
        (filter.tradeId === undefined || t.trade_id === filter.tradeId),
    );
  }

  complete(taskId: string, result: Record<string, unknown>): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== 'PENDING') throw new Error(`task ${taskId} is ${task.status}, expected PENDING`);
    task.status = 'DONE';
    task.result = result;
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    if (task.status !== 'PENDING') throw new Error(`task ${taskId} is ${task.status}, expected PENDING`);
    task.status = 'CANCELLED';
  }

  /** M6 never calls this; kept for interface completeness. */
  toEvent(_taskId: string, _eventType: string, _ctx: { agentId: string; secretKey: string }): SignedFile {
    throw new Error('InMemoryHumanTaskStore.toEvent is not implemented (M7-owned)');
  }
}

export type { HumanTask, HumanTaskStore, TaskType };
