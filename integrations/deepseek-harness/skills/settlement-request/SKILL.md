---
name: settlement-request
description: 买方通过参考结算适配器发 PAYMENT_REQUESTED（AGREED → PAYMENT_PENDING）。前提：DEAL 有效且 DEAL_SIGNED 已记录。test-voucher 仅测试；manual-settlement 在真实外部付款完成前创建人工 PAY 任务。不要把到付/账期伪装成已付款。
---

# settlement-request

## 用途

DEAL 双方签妥后的付款起点（M6 适配器）。接受 DEAL 信封或其 object_id。

## 参数

| 参数 | 说明 |
| --- | --- |
| `deal` | 已签 DEAL 信封；与 `object_id` 二选一 |
| `object_id` | 已存 DEAL 的 object_id；与 `deal` 二选一 |
| `method` | 参考适配器选择：`test-voucher`（默认，仅测试）或 `manual-settlement`（外部真实付款） |
| `actor` | 可选，请求方（需本地私钥）；缺省 daemon 默认 agent |

## 返回

简短摘要 + `object_id`：`{trade_id, method, state}`（state 进入 PAYMENT_PENDING）。

## 红线

DEAL 必须验签有效且事件状态机已到 AGREED，否则拒绝；金额和实际结算条款以 DEAL settlement 为准，不接受调用方另给金额。这里的 `method` 参数选择本地执行适配器，不会把任意支付渠道变成已集成钱包。

没有可用钱包时先与对方协商人工转账、商家内嵌支付、担保或其他方式，再使用 `manual-settlement` 创建任务。对于货到付款、账期或分阶段付款，V0.2 状态机尚不支持其事件顺序；保留 DEAL，不要为推进状态而虚构付款完成。
