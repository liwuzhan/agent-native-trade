import { simpleParser } from 'mailparser';

/** A decoded attachment extracted from an inbound MIME message. */
export interface ParsedAttachment {
  filename: string;
  content: Buffer;
}

/** Structured view of a parsed inbound message. */
export interface ParsedMail {
  messageId: string;
  inReplyTo?: string;
  from: string;
  subject: string;
  text: string;
  /** Value of the `X-Trade-Id` header ('' when absent). */
  tradeId: string;
  attachments: ParsedAttachment[];
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/**
 * Parse a raw RFC 822 source into the fields the adapter needs. Association
 * with a trade happens via the `X-Trade-Id` header.
 */
export async function parseRaw(source: Buffer): Promise<ParsedMail> {
  const mail = await simpleParser(source);
  const tradeId = firstString(mail.headers.get('x-trade-id')) ?? '';
  const from = mail.from?.value?.[0]?.address ?? '';
  const messageId = mail.messageId ?? '';
  const inReplyTo = firstString(mail.inReplyTo);
  const attachments: ParsedAttachment[] = [];
  for (const a of mail.attachments) {
    if (!a.filename) continue;
    // Inline (cid:) parts are embedded images, not trade payloads — skip them.
    if ((a.contentDisposition ?? '').toLowerCase() === 'inline') continue;
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
    attachments.push({ filename: a.filename, content });
  }

  return {
    messageId,
    inReplyTo,
    from,
    subject: mail.subject ?? '',
    text: mail.text ?? '',
    tradeId,
    attachments,
  };
}
