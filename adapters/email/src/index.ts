/**
 * @agent-trade/email — SMTP send / IMAP poll / MIME parse adapter (module M5).
 *
 * Public surface per docs/module-cards/M5-email.md: createMailAdapter plus the
 * OutboundMsg / InboundMsg / MailAdapter / MailConfig types.
 */
export { createMailAdapter } from './adapter.js';
export type { InboundMsg, MailAdapter, MailConfig, OutboundMsg } from './types.js';
