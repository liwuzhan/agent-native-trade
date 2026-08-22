---
name: trade-record-event
description: 用本地私钥签署并应用一个 TRADE_EVENT 到交易状态机（DEAL_SIGNED→AGREED 起，直至 COMPLETED；非法跃迁被拒）。返回新状态。
---

# trade-record-event

## 用途

推进交易状态机：`AGREED → PAYMENT_PENDING → PAYMENT_CONFIRMED → FULFILLING → SHIPPED → DELIVERED → COMPLETED`，分支 `DISPUTED / RESOLVED / CANCELLED`。付款事件不越级；`COMPLETED` 只能由 DELIVERED 之后的事件触发。

## 参数

| 参数 | 说明 |
| --- | --- |
| `trade_id` | 必填，来自 DEAL |
| `event_type` | 必填：DEAL_SIGNED / PAYMENT_REQUESTED / PAYMENT_CONFIRMED / ESCROWED / FULFILLING / SHIPPED / DELIVERED / COMPLETED / DISPUTED / RESOLVED / CANCELLED |
| `actor` | 可选，事件签署者（需本地私钥）；缺省 daemon 默认 agent |
| `evidence` / `message` | 可选，自由结构证据 / 人类可读说明 |

## 内部步骤

1. body 先过 `trade-event-body.schema.json`（含 event_type 枚举）再签。
2. 单签 TRADE_EVENT → `store.applyEvent`（四步验签 + 状态机校验）→ 持久化事件日志。
3. 非法跃迁 / 未知签署者 → 拒绝并返回原因。

## 返回

简短摘要 + `object_id`（事件信封 sha256 id）：`{trade_id, event_type, actor, state}`。

## 注意

human task 完成后的事件用本工具发（`human_task_complete` 只改任务状态，不发事件）。
