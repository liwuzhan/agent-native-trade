---
name: human-task-cancel
description: 取消 PENDING 人工任务（置 CANCELLED）。只有 PENDING 可取消；已 DONE/CANCELLED 拒绝并返回原因。
---

# human-task-cancel

## 用途

M7 任务撤销：条件不再成立时关闭任务。

## 参数

| 参数 | 说明 |
| --- | --- |
| `task_id` | 必填，human_task_create 返回的任务 id（uuid v7） |

## 返回

简短摘要 + `object_id`（= task_id）：`{task_id, status: 'CANCELLED'}`。
