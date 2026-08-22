# 模块卡片：M5 email 适配器

- **目标**：实现 `adapters/email`——SMTP 发送 / IMAP 收取 / MIME 解析 / 大小前置限制 / `X-Trade-Id` 关联 / 接收幂等。模型间的第一通信信道。
- **输入**：技术选型 V0.4 §3（含 3.3 关联与幂等、3.4 安全处理）；不依赖其他包（纯适配器）。

## 输出

`adapters/email/`，ESM + TS strict：

```ts
export interface OutboundMsg { to: string; tradeId: string; subject: string; text?: string; attachments?: { filename: string; data: Uint8Array }[] }
export interface InboundMsg { tradeId: string; from: string; messageId: string; inReplyTo?: string; text: string; attachments: { filename: string; path: string }[] }
export interface MailAdapter {
  send(msg: OutboundMsg): Promise<void>
  poll(): Promise<InboundMsg[]>   // 只返回新邮件；重复投递被幂等吸收
  close(): Promise<void>
}
export function createMailAdapter(config: MailConfig): MailAdapter
// MailConfig: { smtpUrl, imapUrl, inboxDir, seenStorePath, maxMailBytes?, maxAttachmentBytes? }（默认值 10MB / 2MB）
```

硬性规则：

- 发送：`X-Trade-Id: <tradeId>` 头必带；回复场景由调用方传 `inReplyTo`（放在 OutboundMsg 可选字段，若加则同步改卡片）。
- **大小限制前置于完整解析**：IMAP 先取 `RFC822.SIZE`，超 `maxMailBytes` 直接跳过不下载；附件超 `maxAttachmentBytes` 拒绝落地。
- 附件只写入 `inboxDir`，**永不执行**；文件名做路径穿越清洗（拒绝 `../`、绝对路径）。
- 幂等：`seenStorePath` 持久化已处理的 `Message-ID`，重复投递不产生重复 `InboundMsg`。

依赖：`nodemailer`、`imapflow`、`mailparser`；dev：`vitest`。

## 验收指标（即测试）

1. **单元测试**（无服务器）：用内存 Mailbox/maildir fixture 测解析、关联、幂等、大小拒绝、路径穿越清洗。
2. **GreenMail 集成测试**（`tests/integration/email.greenmail.test.ts`，环境变量 `GREENMAIL=1` 门控）：提供 `docker-compose.greenmail.yml`（绿邮 SMTP 3025/IMAP 3143）；真实 send→poll 往返、附件落地、`X-Trade-Id` 完整、重复投递幂等。
3. 超限邮件在**未完整下载正文**的情况下被拒（用 IMAP fetch 记录断言只取了 SIZE/HEADER）。
4. `vitest run`（单元）全绿；`GREENMAIL=1 vitest run`（集成）全绿；`tsc -b` 无错误。

## 边界

- 不做：OAuth 流程 UI、邮件线程重建算法、spam 对抗（登记 FUTURE §4）。
- 不做交易语义——本适配器只搬消息，不认识 DEAL/RECEIPT 等对象（那是 M2 的事）。
- 取舍登记到 `FUTURE.md`。
