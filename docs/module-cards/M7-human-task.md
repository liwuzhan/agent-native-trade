# 模块卡片：M7 human-task 适配器

- **目标**：实现 `adapters/human-task`——本地人类任务接口：模型开任务、人类执行并回传、模型据此生成签名 `TRADE_EVENT`。`HUMAN_TASK` 是本地执行接口，不属于市场核心协议。
- **输入**：`@agent-trade/signed-files`（M2）、`@agent-trade/local-store`（M3）；协议文档 §7.2。

## 输出

```ts
export type TaskType = 'PAY'|'PURCHASE'|'INSPECT'|'PRODUCE'|'PICKUP'|'SHIP'|'RECEIVE'
export type TaskStatus = 'PENDING'|'DONE'|'CANCELLED'
export interface HumanTask { task_id: string; trade_id: string; task_type: TaskType; instructions: string; deadline?: string; required_output?: string[]; status: TaskStatus; result?: Record<string, unknown> }
export interface HumanTaskStore {
  create(t: Omit<HumanTask, 'task_id'|'status'>): string         // task_id = uuid v7
  get(taskId: string): HumanTask | undefined
  list(filter?: { status?: TaskStatus; tradeId?: string }): HumanTask[]
  complete(taskId: string, result: Record<string, unknown>): void        // PENDING→DONE
  cancel(taskId: string): void
  toEvent(taskId: string, eventType: string, ctx: { agentId: string; secretKey: string }): SignedFile  // 生成签名 TRADE_EVENT 并 applyEvent
}
export function createHumanTaskStore(store: Store): HumanTaskStore
```

规则：

- 任务落盘 `.data/tasks/<task_id>.json`（在 M3 布局下扩展，需在 M3 卡片基础上声明该子目录），并同步进 `index.sqlite` 的任务表；
- `toEvent` 把 `result` 放进事件 `evidence`，`message` 自动生成摘要；事件 `verifyFile === 'valid'`；
- 只有 `DONE` 的任务能 `toEvent`；`deadline` 过期查询由 `list` 的调用方过滤（不做定时器）。

依赖：`@agent-trade/signed-files`、`@agent-trade/local-store`；dev：`vitest`。

## 验收指标（即测试）

1. CRUD + 状态迁移 `PENDING→DONE/CANCELLED`；`DONE` 后不可再 `complete`。
2. 与 M6 联调：`manual-settlement` 创建 PAY 任务 → `complete` → `toEvent('PAYMENT_CONFIRMED')` → `stateOf(tradeId) === 'PAYMENT_CONFIRMED'`。
3. `toEvent` 产物 `verifyFile === 'valid'` 且 `evidence` 含任务结果；非 DONE 任务调用抛错。
4. 删 `index.sqlite` 重建后任务列表仍在（任务文件在 `.data/tasks/`）。
5. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：人类 UI/通知（打印或写文件即可）；不做权限体系；不做定时催办。
