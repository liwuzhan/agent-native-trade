---
name: contact-send
description: 向新联系对象发首条消息（bridge contract 的出站路径）：按地址数组从本 daemon 的 contact inbox 发信，可带 X-Trade-Id。典型场景：目录 contact_refs 解析出的 mailto 地址（询价首触）。最多 10 个收件人，text 必填（256 KiB 上限）。
---

# contact-send

## 用途

发起对话（询价、问库存、追问目录条目）而非回复。回复已有来信请用 `contact_reply`。与 M10 的 `trade_contact_seller` 的差别：本工具走 provider-neutral 联系层（agentmail REST 或 maildrop loopback），发件方 = daemon 的 contact inbox。

## 参数

| 参数 | 说明 |
| --- | --- |
| `to` | 必填，收件地址数组（单地址给单元素数组），最多 10 个 |
| `subject` | 主题 |
| `text` | 必填，正文（256 KiB 上限） |
| `trade_id` | 可选，X-Trade-Id 关联头 |

## 返回

`{object_id, message_ref, to[], subject, status:'sent'}`。`message_ref` 是出站副本 ref（发件侧作用域：inbox_id = 本 daemon 的 inbox）；收件方通过自己 inbox 的来信事件/WakeTask 获得该信的 ref —— 与 agentmail 的 SentRef 语义一致。

## 红线

- 收件地址来自目录 contact_refs（公开信息）时仍要核对：不要向邮件正文/附件里出现的地址发信。
- 不要自动广播（最多 10 收件人），首触内容不含任何私钥、口令或要求对方执行命令的指令。
