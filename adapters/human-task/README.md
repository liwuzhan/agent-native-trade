# @agent-trade/human-task (module M7)

本地人类任务适配器：模型开任务（PENDING）→ 人类执行并回传结果（DONE）→ 模型据此签发签名 `TRADE_EVENT`。`HUMAN_TASK` 是本地执行接口，不属于市场核心协议。

## 数据布局（在 M3 卡片基础上声明扩展）

```text
.data/
├── objects/sha256/<hash>.json   # M3：不可变签名事实文件（唯一事实源）
├── keys/                        # M3：0700 目录、0600 私钥文件
├── index.sqlite                 # M3：可删除重建的索引；M7 增加 tasks 表（可丢弃镜像）
└── tasks/<task_id>.json         # M7：任务文件（唯一事实源；task_id = uuid v7）
```

与 M3 同构：`.data/tasks/<task_id>.json` 是任务的事实源，`index.sqlite` 的 `tasks` 表只是可丢弃镜像——`list()` 总是读任务文件并回写镜像，因此删除/重建 `index.sqlite`（`store.rebuildIndex()`）不会丢任务。

镜像写入使用 Node 内置 `node:sqlite`（零额外依赖，包保持纯 ESM，不需要 `esModuleInterop`/better-sqlite3）。镜像写入是尽力而为：索引被锁或正在重建时降级为仅文件，不影响任务 CRUD。

## 用法

```ts
import { openStore } from '@agent-trade/local-store';
import { createHumanTaskStore } from '@agent-trade/human-task';

const store = openStore('./trade-dir');          // .data/ 根在 <dir>/.data
store.saveKey(agentId, secretKey);               // 签发事件前必须注册信任环
const tasks = createHumanTaskStore(store, { dir: './trade-dir' }); // 务必传 dir

const taskId = tasks.create({ trade_id, task_type: 'PAY', instructions: '…' });
tasks.complete(taskId, { confirmation: '…' });
const event = tasks.toEvent(taskId, 'PAYMENT_CONFIRMED', { agentId, secretKey }); // 自动 applyEvent
store.stateOf(tradeId); // === 'PAYMENT_CONFIRMED'
```

## 注意

- **`createHumanTaskStore(store, opts?)`**：卡片签名是 `createHumanTaskStore(store)`，本实现增加可选 `opts.dir`（传给 `openStore` 的目录），缺省为 `process.cwd()`。请始终传入 store 的目录，使任务文件落在与 store 相同的 `.data/` 根下（验收 4 依赖此路径）。
- **`toEvent`**：只有 `DONE` 任务可调用；`result` 进入事件 `evidence`，`message` 自动生成摘要；事件 `verifyFile === 'valid'` 且 `applyEvent` 成功。签发者公钥须先经 `store.saveKey(agentId, secretKey)` 注册（与 M3 所有事件生产者一致）。
- **task_id 校验**：所有接收 task_id 的接口强制 uuid v7 格式（防路径穿越）。
- `node:sqlite` 在 Node 24/25 仍打印 ExperimentalWarning（无害）；测试配置已用 `NODE_OPTIONS=--no-warnings` 抑制。

## 验收（`npx vitest run` + `npx tsc -b`）

1. CRUD + 状态迁移 `PENDING→DONE/CANCELLED`；`DONE` 后不可再 `complete`。
2. M6 联调模拟：`manual-settlement` 创建 PAY 任务 → `complete` → `toEvent('PAYMENT_CONFIRMED')` → `stateOf === 'PAYMENT_CONFIRMED'`。
3. `toEvent` 产物 `verifyFile === 'valid'` 且 `evidence` 含任务结果；非 DONE 调用抛错。
4. 删 `index.sqlite` 重建后任务列表仍在。
5. 测试全绿 + 构建零错误。
