---
name: settlement-confirm
description: 卖方/执行方确认收款：发 PAYMENT_CONFIRMED（→ PAYMENT_CONFIRMED）。test-voucher 核销 settlement_request 发的券；manual-settlement 要求对应人工 PAY 任务先 DONE。method 必须与 request 一致。
---

# settlement-confirm

## 用途

付款闭环（M6）。接受 DEAL 信封或其 object_id。

## 参数

| 参数 | 说明 |
| --- | --- |
| `deal` | 已签 DEAL 信封；与 `object_id` 二选一 |
| `object_id` | 已存 DEAL 的 object_id；与 `deal` 二选一 |
| `method` | 必须与 settlement_request 一致（默认 test-voucher） |
| `actor` | 可选，确认方（需本地私钥） |

## 返回

简短摘要 + `object_id`：`{trade_id, method, state}`（state 进入 PAYMENT_CONFIRMED）。

## 红线

券核销/任务状态由适配器校验（test-voucher 券不存在或已用、manual 任务未 DONE 均拒绝）。签名事件由模型发出，但 `manual-settlement` 的真实付款必须已经由人类或外部服务完成并回传凭证；不得把“同意到付”当成“已经收款”。
