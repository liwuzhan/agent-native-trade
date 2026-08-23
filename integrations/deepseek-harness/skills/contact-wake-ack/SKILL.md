---
name: contact-wake-ack
description: 确认一个 WakeTask 处理完毕：把 pending/ 里的任务迁到 done/（幂等，去重证据保留）。只能 ack 本 daemon 联系 inbox 的任务；未知或他箱任务报错。
---

# contact-wake-ack

## 用途

`contact_wake_list` →（可选 `contact_message_get` / `contact_reply`）→ `contact_wake_ack` 闭环的最后一步。ack 不删除文件，只是迁移目录——同一封邮件在 WebSocket 重连补发或进程重启后仍会落到同一 task_id，done/ 里的文件就是去重证据。

## 参数

| 参数 | 说明 |
| --- | --- |
| `task_id` | 必填，来自 `contact_wake_list` 的 task_id |

## 返回

`{object_id, task_id, status:'acked', path}`（path = done/ 内的文件路径）。

## 红线

- 未处理完不要 ack：ack 后任务从待办消失，误 ack 会漏处理真实来信。
- ack 前确认该任务确属本 daemon 的 inbox（工具已强制过滤，跨箱 ack 直接报错）。
