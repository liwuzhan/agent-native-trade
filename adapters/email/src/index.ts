/**
 * @agent-trade/email — SMTP send / IMAP poll / MIME parse adapter (module M5).
 *
 * Public surface per docs/module-cards/M5-email.md: createMailAdapter plus the
 * OutboundMsg / InboundMsg / MailAdapter / MailConfig types. The MailboxSource /
 * SendTransport / SendPayload injection seams are re-exported for M10's
 * file-maildrop loopback (same seam the llm-doll-trade demo uses).
 */
export { createMailAdapter } from './adapter.js';
export type { InboundMsg, MailAdapter, MailConfig, OutboundMsg } from './types.js';
export type { EnvelopeMeta, MailboxSource } from './imap.js';
export type { SendPayload, SendTransport } from './smtp.js';
// parseRaw 供 M10+ 的 file-maildrop 联系适配器（DSH plugin contact provider）
// 复用同一 MIME 解析器：只导出纯函数，不改变 M5 现有测试与公开契约。
export { parseRaw } from './parse.js';
export type { ParsedAttachment, ParsedMail } from './parse.js';
