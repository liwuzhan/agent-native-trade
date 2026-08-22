/**
 * Test helper: build raw RFC 822 sources by hand (no SMTP server needed).
 */

export interface RawAttachment {
  filename: string;
  contentType?: string;
  /** Disposition; 'attachment' by default, use 'inline' for cid images. */
  disposition?: 'attachment' | 'inline';
  content: Buffer;
}

export interface RawMessageOptions {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  tradeId?: string;
  text?: string;
  attachments?: RawAttachment[];
}

function wrapBase64(data: Buffer, width = 76): string {
  const b64 = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) {
    lines.push(b64.slice(i, i + width));
  }
  return lines.join('\r\n');
}

function quoteHeaderValue(value: string): string {
  return value.includes('"') || value.includes('\\') || value.includes('\n')
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
}

/** Build a minimal but standards-shaped message with CRLF line endings. */
export function buildRawMessage(opts: RawMessageOptions): Buffer {
  const headers: string[] = ['MIME-Version: 1.0'];
  if (opts.from) headers.push(`From: ${opts.from}`);
  if (opts.to) headers.push(`To: ${opts.to}`);
  if (opts.subject) headers.push(`Subject: ${opts.subject}`);
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.tradeId !== undefined) headers.push(`X-Trade-Id: ${opts.tradeId}`);
  headers.push('Date: Thu, 01 Jan 2026 00:00:00 +0000');

  const text = opts.text ?? '';
  const attachments = opts.attachments ?? [];

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return Buffer.from([...headers, '', text].join('\r\n'));
  }

  const boundary = `----agent-trade-${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  // only emit a text part when there is actual text (attachment-only mail
  // carries no text/plain part, mirroring real-world senders)
  if (text !== '') {
    parts.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text);
  }
  for (const a of attachments) {
    const contentType = a.contentType ?? 'application/octet-stream';
    const disposition = a.disposition ?? 'attachment';
    const dispHeader =
      disposition === 'inline'
        ? `Content-Disposition: inline; filename=${quoteHeaderValue(a.filename)}`
        : `Content-Disposition: attachment; filename=${quoteHeaderValue(a.filename)}`;
    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      dispHeader,
      '',
      wrapBase64(a.content),
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from([...headers, '', ...parts].join('\r\n'));
}
