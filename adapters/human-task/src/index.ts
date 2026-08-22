/**
 * @agent-trade/human-task — local human-task adapter (module M7).
 *
 * A model opens a task (PENDING), a human performs it and reports a result
 * (DONE), and the model mints a signed TRADE_EVENT from the completed task via
 * `toEvent`. Tasks persist under `.data/tasks/<task_id>.json` (M3 layout
 * extension) with a disposable mirror in index.sqlite's `tasks` table.
 */

export type { TaskType, TaskStatus, HumanTask, HumanTaskStore } from './types.js';
export type { HumanTaskStoreOptions } from './store.js';
export { createHumanTaskStore } from './store.js';
export { uuidv7 } from './uuid.js';
