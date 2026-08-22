# 模块卡片：M6 settlement 适配器

- **目标**：实现 `adapters/settlement`——`test-voucher` 与 `manual-settlement` 双结算适配器，把交易从 `AGREED` 推进到 **`FULFILLING`**（付款≠完成，`COMPLETED` 归物流/签收事件）。
- **输入**：`@agent-trade/signed-files`（M2）、`@agent-trade/local-store`（M3）；技术选型 V0.4 §4。

## 输出

```ts
export interface SettlementContext { store: Store; agentId: string; secretKey: string }
export interface SettlementAdapter {
  method: string                                   // 'test-voucher' | 'manual-settlement'
  request(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>   // 买方发 PAYMENT_REQUESTED
  confirm(deal: SignedFile, ctx: SettlementContext): Promise<SignedFile>   // 卖方/执行方发 PAYMENT_CONFIRMED，并 applyEvent
}
export function createTestVoucherAdapter(opts?: { issuer?: string }): SettlementAdapter
export function createManualSettlementAdapter(opts: { taskStore: HumanTaskStore }): SettlementAdapter  // 复用 M7
```

规则：

- `test-voucher`：发行**完全虚构**的凭证（`TEST-VOUCHER-<uuid>`），面额必须与 `deal.body.settlement.amount` 的十进制定点字符串精确匹配（不等即拒）；核销后即作废（本地登记）。
- `manual-settlement`：创建 M7 人类任务（`task_type: PAY`），人类完成后由模型签发 `PAYMENT_CONFIRMED`。
- 产生的每个事件都必须 `verifyFile === 'valid'` 并成功 `applyEvent`；状态链 `AGREED→PAYMENT_PENDING→PAYMENT_CONFIRMED`，随后 `FULFILLING` 事件由卖方签发（适配器提供 `markFulfilling` 辅助函数）。
- **禁止**在任何持久化/公开字段中存放真实秘密；事件 evidence 只放方法、执行方引用、凭证 id。

依赖：`@agent-trade/signed-files`、`@agent-trade/local-store`；dev：`vitest`。

## 验收指标（即测试）

1. 两条路径各自走完 `AGREED→PAYMENT_PENDING→PAYMENT_CONFIRMED→FULFILLING`，全部事件 `verifyFile === 'valid'`，状态机迁移成功。
2. 面额不匹配（`"3200.00"` vs `"3200.0"`/金额不符）时 `confirm` 拒绝。
3. `test-voucher` 重复核销同一代码必须拒绝。
4. 扫描所有落盘对象与事件，断言不存在疑似秘密字段（无 `cardSecret`/`password`/`pin` 等键）。
5. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做真实支付/钱包/加密传输（FUTURE §3）；不推进到 `SHIPPED` 之后（那是物流事件）；`COMPLETED` 不在本模块。
