/**
 * wake.ts — contact_wake_list / contact_wake_ack（WakeTask 队列消费）。
 *
 * 队列由 trade-inboxd（或本地演示预置）写入 FileWakeQueue（pending/ + done/）。
 * WakeTask 本身很小（不含正文/附件 —— 生成侧红线），list 只做数量上限与
 * inbox 过滤；ack 把任务移入 done/（保留去重证据，与 contact-core 语义一致）。
 *
 * 过滤：WakeTask.inbox_id 必须等于本 daemon 的 contactInboxId（agentmail =
 * 配置的 inbox；maildrop = 收件地址），避免同机多 preset 互相看见对方的任务。
 */

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';

const MAX_TASKS = 20;

export async function contactWakeList(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0
    ? Math.min(args.limit, MAX_TASKS)
    : MAX_TASKS;

  const pending = (await app.wakeQueue.listPending()).filter((task) => task.inbox_id === app.contactInboxId);

  return {
    object_id: `wake-queue:${app.contactProvider}:${app.contactInboxId}`,
    total_pending: pending.length,
    tasks: pending.slice(0, limit).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      created_at: task.created_at,
      from: task.from,
      ...(task.subject !== undefined ? { subject: task.subject } : {}),
      ...(task.trade_id !== undefined ? { trade_id: task.trade_id } : {}),
      inbox_id: task.inbox_id,
      message_ref: task.message_ref,
      next_actions: task.next_actions,
    })),
    status: 'listed',
  };
}

export async function contactWakeAck(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  if (typeof args.task_id !== 'string' || args.task_id.length === 0) {
    throw new Error('contact_wake_ack: "task_id" is required');
  }
  const task = await app.wakeQueue.get(args.task_id);
  if (task === undefined) throw new Error(`contact_wake_ack: unknown task_id ${args.task_id}`);
  if (task.inbox_id !== app.contactInboxId) {
    throw new Error(`contact_wake_ack: task ${args.task_id} belongs to inbox ${task.inbox_id}, not ${app.contactInboxId}`);
  }
  const path = await app.wakeQueue.ack(args.task_id);
  return { object_id: `wake-task:${args.task_id}`, task_id: args.task_id, status: 'acked', path };
}

export function assertMessageRefArgs(args: Record<string, unknown>): { provider: string; inboxId: string; messageId: string } {
  const ref = args.message_ref;
  if (!isPlainObject(ref)) throw new Error('"message_ref" is required: {provider, inbox_id, message_id}');
  const provider = typeof ref.provider === 'string' ? ref.provider : '';
  const inboxId = typeof ref.inbox_id === 'string' ? ref.inbox_id : '';
  const messageId = typeof ref.message_id === 'string' ? ref.message_id : '';
  if (provider.length === 0 || inboxId.length === 0 || messageId.length === 0) {
    throw new Error('"message_ref" must contain non-empty provider, inbox_id and message_id');
  }
  return { provider, inboxId, messageId };
}
