/**
 * human-task.ts — M7 human-task 工具的 DSH 侧接线。
 *
 * human_task_create / complete / list / cancel，全部落在 M7 的文件化 store
 * （.data/tasks/ 为真相源，index.sqlite 为可弃镜像）。任务结果（result）为
 * 人类提供的数据：照原样落盘、照 Schema 校验、绝不执行。
 */

import type { TaskStatus } from '@agent-trade/human-task';

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';

const MAX_LISTED = 10;

export function humanTaskCreate(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const tradeId = typeof args.trade_id === 'string' && args.trade_id.length > 0 ? args.trade_id : undefined;
  if (tradeId === undefined) throw new Error('human_task_create: "trade_id" is required');
  const taskType = typeof args.task_type === 'string' ? args.task_type : undefined;
  if (taskType === undefined) throw new Error('human_task_create: "task_type" is required');
  const instructions = typeof args.instructions === 'string' ? args.instructions : undefined;
  if (instructions === undefined || instructions.length === 0) throw new Error('human_task_create: "instructions" is required');

  const taskId = app.humanTasks.create({
    trade_id: tradeId,
    task_type: taskType as never, // 枚举在 M7 store 内校验（TASK_TYPES），无效即抛
    instructions,
    ...(typeof args.deadline === 'string' && args.deadline.length > 0 ? { deadline: args.deadline } : {}),
    ...(Array.isArray(args.required_output) ? { required_output: args.required_output as string[] } : {}),
  });
  return { object_id: taskId, task_id: taskId, trade_id: tradeId, task_type: taskType, status: 'PENDING' };
}

export function humanTaskComplete(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
  if (taskId === undefined) throw new Error('human_task_complete: "task_id" is required');
  if (!isPlainObject(args.result)) throw new Error('human_task_complete: "result" must be a JSON object');
  app.humanTasks.complete(taskId, args.result);
  return { object_id: taskId, task_id: taskId, status: 'DONE' };
}

export function humanTaskList(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const status = typeof args.status === 'string' ? (args.status as TaskStatus) : undefined;
  const tradeId = typeof args.trade_id === 'string' && args.trade_id.length > 0 ? args.trade_id : undefined;
  const tasks = app.humanTasks
    .list({
      ...(status !== undefined ? { status } : {}),
      ...(tradeId !== undefined ? { tradeId } : {}),
    })
    .slice(0, MAX_LISTED)
    .map((t) => ({ task_id: t.task_id, trade_id: t.trade_id, task_type: t.task_type, status: t.status }));
  return { object_id: tradeId ?? '', tasks, count: tasks.length };
}

export function humanTaskCancel(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
  if (taskId === undefined) throw new Error('human_task_cancel: "task_id" is required');
  app.humanTasks.cancel(taskId);
  return { object_id: taskId, task_id: taskId, status: 'CANCELLED' };
}
