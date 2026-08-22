/**
 * Public types of the email adapter (module M5).
 *
 * Keep in sync with docs/module-cards/M5-email.md.
 */

/** Outbound message sent via SMTP. `X-Trade-Id` is always attached. */
export interface OutboundMsg {
  to: string;
  tradeId: string;
  subject: string;
  text?: string;
  /** Message-ID this message replies to (adds In-Reply-To header). */
  inReplyTo?: string;
  attachments?: { filename: string; data: Uint8Array }[];
}

/** Inbound message produced by {@link MailAdapter.poll}. */
export interface InboundMsg {
  tradeId: string;
  from: string;
  messageId: string;
  inReplyTo?: string;
  text: string;
  attachments: { filename: string; path: string }[];
}

export interface MailAdapter {
  /** Send one outbound message over SMTP. */
  send(msg: OutboundMsg): Promise<void>;
  /** Fetch new messages from the IMAP inbox. Only returns new mail; duplicate
   *  deliveries are absorbed by the Message-ID idempotency store. */
  poll(): Promise<InboundMsg[]>;
  /** Release resources (SMTP connection, IMAP connection, flush seen store). */
  close(): Promise<void>;
}

export interface MailConfig {
  /** SMTP server URL, e.g. `smtp://user:pass@host:587` or `smtps://...`. */
  smtpUrl: string;
  /** IMAP server URL, e.g. `imap://user:pass@host:143` or `imaps://...`. */
  imapUrl: string;
  /** Directory that landed attachments are written into. */
  inboxDir: string;
  /** File path used to persist processed Message-IDs (idempotency). */
  seenStorePath: string;
  /** Messages larger than this are skipped without downloading the body (default 10 MiB). */
  maxMailBytes?: number;
  /** Attachments larger than this are rejected and never written (default 2 MiB). */
  maxAttachmentBytes?: number;
}
