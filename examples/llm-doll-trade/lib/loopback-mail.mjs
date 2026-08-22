/**
 * lib/loopback-mail.mjs — M5 邮件通道的无 Docker 模式（loopback）。
 *
 * 直接复用 `@agent-trade/email` 的 deps 注入缝（README §"Internal seams"）：
 * 把一个进程内的共享"内存信箱"实现为 MailboxSource（收件侧）与
 * SendTransport（发件侧），其余（X-Trade-Id 关联、seen 幂等、附件落盘、
 * 大小门限）全部由真实适配器完成 —— 与 GreenMail 模式走的是同一段
 * adapter 代码，只是 SMTP/IMAP 换成了进程内信箱。
 *
 * 原始 RFC 822 渲染（multipart/mixed + base64 附件）对齐
 * adapters/email/tests/helpers/raw.ts 的形状，保证 mailparser 能解析。
 */

/** 一条信箱记录：uid 递增，source 为可被 mailparser 解析的原始 RFC 822。 */
class MailRecord {
  constructor(uid, messageId, inReplyTo, source) {
    this.uid = uid;
    this.messageId = messageId;
    this.inReplyTo = inReplyTo;
    this.source = source;
    this.size = source.byteLength;
  }
}

/** 进程内共享信箱：<收件地址, MailRecord[]>，外加一封封的投递轨迹。 */
export class SharedMailboxes {
  constructor() {
    /** @type {Map<string, MailRecord[]>} */
    this.byAddress = new Map();
    /** 投递轨迹（供断言检查邮件往来，如议价三封）。 */
    this.trace = [];
    this._uid = 0;
  }

  _listOf(address) {
    let list = this.byAddress.get(address);
    if (list === undefined) {
      list = [];
      this.byAddress.set(address, list);
    }
    return list;
  }

  /** 渲染并投递一封原始邮件到 `to`。payload 即适配器传给 transport 的 SendPayload。 */
  deliver(to, payload) {
    const messageId = `<demo-${++this._uid}-${Math.random().toString(36).slice(2, 10)}@doll-trade.local>`;
    const source = renderRawMessage(payload, messageId);
    this._listOf(to).push(new MailRecord(this._uid, messageId, payload.inReplyTo, source));
    this.trace.push({
      from: payload.from,
      to,
      subject: payload.subject,
      tradeId: payload.headers?.['X-Trade-Id'],
      inReplyTo: payload.inReplyTo,
      messageId,
      attachments: (payload.attachments ?? []).map((a) => a.filename),
    });
    return messageId;
  }
}

/** MailboxSource 实现（M5 imap.ts 的结构化契约）：某收件地址的信箱。 */
export class LoopbackSource {
  /** @param {SharedMailboxes} shared @param {string} address 本适配器收件的地址 */
  constructor(shared, address) {
    this.shared = shared;
    this.address = address;
    this.closed = false;
  }

  async list() {
    const list = this.shared._listOf(this.address);
    return [...list]
      .sort((a, b) => a.uid - b.uid)
      .map((m) => ({ uid: m.uid, size: m.size, messageId: m.messageId, inReplyTo: m.inReplyTo }));
  }

  async download(uid) {
    const record = this.shared._listOf(this.address).find((m) => m.uid === uid);
    if (!record) throw new Error(`LoopbackSource: no message with uid ${uid} in ${this.address}`);
    return record.source;
  }

  async close() {
    this.closed = true;
  }
}

/** SendTransport 实现（M5 smtp.ts 的结构化契约）：投递到共享信箱。 */
export class LoopbackTransport {
  /** @param {SharedMailboxes} shared @param {string} fromAddress SMTP 信封发件人 */
  constructor(shared, fromAddress) {
    this.shared = shared;
    this.fromAddress = fromAddress;
    this.closed = false;
  }

  async send(payload) {
    this.shared.deliver(payload.to, { ...payload, from: payload.from ?? this.fromAddress });
  }

  async close() {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// 原始 RFC 822 渲染（与 adapters/email/tests/helpers/raw.ts 对齐）
// ---------------------------------------------------------------------------

function wrapBase64(data, width = 76) {
  const b64 = Buffer.from(data).toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join('\r\n');
}

function quoteHeaderValue(value) {
  return value.includes('"') || value.includes('\\') || value.includes('\n')
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;
}

/**
 * 把适配器的 SendPayload 渲染成可解析的原始邮件。附件一律走
 * multipart/mixed + base64；text 为空时不生成 text/plain 段。
 */
export function renderRawMessage(payload, messageId) {
  const headers = ['MIME-Version: 1.0'];
  if (payload.from) headers.push(`From: ${payload.from}`);
  headers.push(`To: ${payload.to}`);
  if (payload.subject !== undefined && payload.subject !== null) headers.push(`Subject: ${payload.subject}`);
  headers.push(`Message-ID: ${messageId}`);
  if (payload.inReplyTo) headers.push(`In-Reply-To: ${payload.inReplyTo}`);
  const tradeId = payload.headers?.['X-Trade-Id'];
  if (tradeId !== undefined && tradeId !== null) headers.push(`X-Trade-Id: ${tradeId}`);
  headers.push('Date: Thu, 01 Jan 2026 00:00:00 +0000');

  const text = payload.text ?? '';
  const attachments = payload.attachments ?? [];

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=utf-8');
    return Buffer.from([...headers, '', text].join('\r\n'), 'utf8');
  }

  const boundary = `----agent-trade-${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [];
  if (text !== '') {
    parts.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text);
  }
  for (const a of attachments) {
    const contentType = a.filename?.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename=${quoteHeaderValue(a.filename ?? 'attachment.bin')}`,
      '',
      wrapBase64(a.content ?? Buffer.alloc(0)),
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from([...headers, '', ...parts].join('\r\n'), 'utf8');
}
