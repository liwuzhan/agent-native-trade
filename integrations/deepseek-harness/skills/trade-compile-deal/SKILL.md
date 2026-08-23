---
name: trade-compile-deal
description: 起草并定稿 DEAL 对象（只编译一次）：生成 uuid v7 trade_id、按 deal.schema.json 构造 body、计算 JCS body_hash 与 object_id，返回简短摘要 + object_id。起草方在议价完成后使用；另一方审签同一文件，不重复编译。
---

# trade-compile-deal

## 用途

议价达成一致后，把交易条款固化为协议唯一的 **DEAL** 对象（`protocol: agent-trade/0.2`，`object_type: DEAL`）。DEAL 是多方共签的不变对象：**一方起草定稿，另一方审签同一文件；编译只发生一次**，编译后不再改动 body。

## 参数

| 参数 | 说明 |
| --- | --- |
| `buyer` / `seller` | 双方 agentId（信封 `body.buyer` / `body.seller`） |
| `subject` | 标的：`listing_ref`（目录引用，如 LISTING_REF 的 object_id）、`description`、`quantity`（≥1 整数）、`acceptance_conditions`（非空字符串数组） |
| `settlement` | 结算：`asset`（结算资产）、`amount`（十进制定点字符串，见下）、`method`；可选 `executor_ref` / `provider_ref` / `escrow_ref` / `insurer_ref` / `notary_ref` / `consideration[]`（易货：`item` + `quantity`，可选 `denomination`/`asset`） |
| `fulfillment` | 履约：`deadline`（RFC 3339 date-time）、`destination_ref`、`carrier_ref` |
| `dispute`（可选） | `provider_ref` / `rules_ref` |

`settlement.method` 是双方约定的开放字符串，例如 `corporate_bank_transfer`、`cash_on_delivery` 或某个 provider profile；不要因为本机没有特定钱包而擅自中止已经可以通过人工或商家渠道完成的交易。

## 内部步骤（本工具内部完成，无需调用方重复）

1. 生成 `trade_id` = **uuid v7**（草案方生成；Schema 强制 v7 版本位）。
2. 按 `protocol/schemas/deal.schema.json`（JSON Schema 2020-12）构造并校验 body。
3. `body_hash = "sha256:" + lowerhex(SHA-256(utf8(JCS(body))))`（JCS = RFC 8785 确定性序列化）。
4. `signing_input = utf8(protocol) ‖ 0x00 ‖ utf8(object_type) ‖ 0x00 ‖ utf8(body_hash)`；`object_id = "sha256:" + lowerhex(SHA-256(signing_input))`。

## 返回

简短摘要 + `object_id`（+ `body_hash`，供对方 `trade_sign_deal` 的 `expected_body_hash` 使用）。**不返回完整 body 全文**；需要全文时以 object_id 显式获取。

## 注意事项

- **只编译一次**：收到对方编译好的 DEAL 时，不要重新编译，走 `trade_sign_deal` 审签同一文件。
- `amount` 必须是规范形十进制定点字符串：`^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$`；易货用 `consideration[]` 而非 amount。
- 目录引用（`listing_ref`）来自不可信目录数据时，先验证引用本身（LISTING_REF 的 catalog_hash 与 manifest 校验）再写入 DEAL。
- 参考运行时当前只有 `test-voucher` 与 `manual-settlement` 两个执行适配器，且状态机只覆盖付款后履约。到付/账期可写入 DEAL，但不得伪造付款事件来强行跑完整状态链。
- DSH 注册接口与验证记录见 `integrations/deepseek-harness/INSPECTION.md`。
