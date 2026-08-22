# 模块卡片：M3 local-store

- **目标**：实现 `@agent-trade/local-store` 包——`.data/` 数据布局、SQLite 本地索引、交易状态机、append-only 事件日志。签名文件是唯一事实源，SQLite 只是可删重建的索引。
- **输入**：M2 的 `@agent-trade/signed-files`（`SignedFile` / `verifyFile` / `objectId`）；开发计划 V0.2 §2 的状态机与 `.data/` 布局。

## 输出

`packages/local-store/`，ESM + TS strict。数据布局：

```text
.data/
├── objects/sha256/<hash>.json   # 不可变事实文件（按 object_id 落盘）
├── keys/                        # 目录 0700，私钥文件 0600
└── index.sqlite                 # 可删除重建的本地索引
```

导出接口：

```ts
export type TradeState = 'AGREED'|'PAYMENT_PENDING'|'PAYMENT_CONFIRMED'|'FULFILLING'|'SHIPPED'|'DELIVERED'|'COMPLETED'|'DISPUTED'|'RESOLVED'|'CANCELLED'
export function openStore(dir: string): Store
export interface Store {
  putObject(file: SignedFile): string            // 先 verifyFile，无效即抛错；返回 object_id；幂等
  getObject(objectId: string): SignedFile | undefined
  rebuildIndex(): void                           // 扫 objects/ 全量重建 index.sqlite
  saveKey(agentId: string, secretKey: string): void   // 0600
  getKey(agentId: string): string | undefined
  applyEvent(tradeId: string, event: SignedFile): TradeState  // 校验事件签名 + 状态机迁移，非法迁移抛错
  stateOf(tradeId: string): TradeState | undefined
  close(): void
}
```

状态机迁移表（`event_type` → 目标态；只允许表内迁移）：

```text
DEAL_SIGNED→AGREED（仅初始）  PAYMENT_REQUESTED→PAYMENT_PENDING
PAYMENT_CONFIRMED/ESCROWED→PAYMENT_CONFIRMED  FULFILLING→FULFILLING
SHIPPED→SHIPPED  DELIVERED→DELIVERED  COMPLETED→COMPLETED（仅自 DELIVERED）
DISPUTED→DISPUTED（任意非终态）  RESOLVED→回到争议前状态（仅自 DISPUTED）  CANCELLED→CANCELLED（任意非终态，终态）
```

依赖：`better-sqlite3`、`@agent-trade/signed-files`；dev：`vitest`。

## 验收指标（即测试）

1. `putObject` 拒绝 `verifyFile` 非 valid 的文件（用篡改向量验证）。
2. **删库重建**：写入若干对象与事件后，物理删除 `index.sqlite`，`rebuildIndex()` 后 `getObject`/`stateOf` 结果与删库前完全一致。
3. 事件表 append-only：API 无更新/删除入口；同一事件重复 `applyEvent` 幂等（状态不变、不重复行）。
4. 状态机：合法链 `DEAL_SIGNED→…→COMPLETED` 全过；`PAYMENT_CONFIRMED` 后直接 `COMPLETED` 必须抛错；`DISPUTED→RESOLVED` 恢复争议前状态；`COMPLETED`/`CANCELLED` 后任何事件抛错。
5. `keys/` 目录权限 0700、私钥文件 0600（`fs.stat` 断言）。
6. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：BT/邮件/检索站；不做密钥生成（M1）；不做 schema（M2）。
- SQLite 表结构自定，但必须能在 rebuildIndex 时从 objects/ 完整推导。
