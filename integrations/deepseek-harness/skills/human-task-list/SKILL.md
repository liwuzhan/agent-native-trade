---
name: human-task-list
description: 列出人工任务（可按状态或交易过滤），返回简短摘要（task_id/status/task_type/trade_id），不含完整 result 正文。
---

# human-task-list

## 用途

查看待办（PENDING）任务与历史。真相源为 `.data/tasks/*.json`；index.sqlite 是可弃镜像。

## 参数

| 参数 | 说明 |
| --- | --- |
| `status` | 可选过滤：PENDING / DONE / CANCELLED |
| `trade_id` | 可选，按交易过滤 |

## 返回

简短摘要 + `object_id`（给定 trade_id 时 = trade_id，否则空）：`{tasks: [{task_id, trade_id, task_type, status}...], count}`（最多 10 条，按创建序）。
