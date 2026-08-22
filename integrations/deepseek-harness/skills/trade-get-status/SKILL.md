---
name: trade-get-status
description: 查询一笔交易的当前状态（状态机 + 事件日志驱动）。返回简短摘要，object_id 即 trade_id。
---

# trade-get-status

## 用途

最小链路收尾与争议排查：查 `trade_id` 的当前状态；无任何事件时返回错误。

## 参数

| 参数 | 说明 |
| --- | --- |
| `trade_id` | 必填，来自 DEAL |

## 返回

简短摘要 + `object_id`（= trade_id，查询对象即 trade_id）：`{trade_id, state}`。state 取值见 `trade-record-event` 的状态机。
