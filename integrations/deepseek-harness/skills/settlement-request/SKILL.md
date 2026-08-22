---
name: settlement-request
description: 买方发起付款：经结算适配器发 PAYMENT_REQUESTED（AGREED → PAYMENT_PENDING）。前提：DEAL 有效且 DEAL_SIGNED 事件已记录。test-voucher（默认，内存券）或 manual-settlement（生成人工 PAY 任务）。
---

# settlement-request

## 用途

DEAL 双方签妥后的付款起点（M6 适配器）。接受 DEAL 信封或其 object_id。

## 参数

| 参数 | 说明 |
| --- | --- |
| `deal` | 已签 DEAL 信封；与 `object_id` 二选一 |
| `object_id` | 已存 DEAL 的 object_id；与 `deal` 二选一 |
| `method` | `test-voucher`（默认）或 `manual-settlement` |
| `actor` | 可选，请求方（需本地私钥）；缺省 daemon 默认 agent |

## 返回

简短摘要 + `object_id`：`{trade_id, method, state}`（state 进入 PAYMENT_PENDING）。

## 红线

DEAL 必须验签有效且事件状态机已到 AGREED，否则拒绝；金额/方法以 DEAL settlement 为准，不接受调用方另给金额。
