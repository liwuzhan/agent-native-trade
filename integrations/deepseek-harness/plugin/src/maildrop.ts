/**
 * maildrop.ts — 文件信箱（M5 适配器的 source/transport 注入缝实现）。
 *
 * 跨进程的确定性邮件通道：两个 daemon（买方/卖方）各持一个 FileMailboxSource
 * + FileSendTransport，指向同一 spool 根目录；每地址一个子目录，邮件为
 * `<uid>.eml`（原始 RFC 822）+ `<uid>.meta.json`（信封元数据）。原子写入
 * （tmp + rename）保证跨进程并发安全；其余（X-Trade-Id 关联、seen 幂等、
 * 附件落盘、大小门限、mailparser 解析）全部由真实 @agent-trade/email
 * 适配器完成 —— 与 GreenMail 模式走同一段 adapter 代码。
 *
 * RFC 822 渲染对齐 examples/llm-doll-trade/lib/loopback-mail.mjs 的形状
 * （multipart/mixed + base64 附件），保证 mailparser 能解析。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MailboxSource } from '@agent-trade/email';
import type { SendTransport } from '@agent-trade/email';
import type { SendPayload } from '@agent-trade/email';

interface EnvelopeMeta {
  uid: number;
  size: number;
  messageId: string;
  inReplyTo?: string;
}

interface MailMeta {
  uid: number;
  messageId: string;
  inReplyTo?: string;
}

const META_RE = /^(\d+)\.meta\.json$/;
const EML_RE = /^(\d+)\.eml$/;

function addressDir(spoolRoot: string, address: string): string {
  const dir = join(spoolRoot, address);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 渲染 SendPayload 为可被 mailparser 解析的原始 RFC 822（对齐 demo 形状）。 */
export function renderRawMessage(payload: SendPayload, messageId: string): Buffer {
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

  const wrapBase64 = (data: Uint8Array, width = 76): string => {
    const b64 = Buffer.from(data).toString('base64');
    const lines: string[] = [];
    for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
    return lines.join('\r\n');
  };
  const quoteHeaderValue = (v: string): string =>
    v.includes('"') || v.includes('\\') || v.includes('\n')
      ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : v;

  const boundary = `----agent-trade-${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  if (text !== '') parts.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text);
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

/**
 * 文件信箱收件侧：list() 读 `<uid>.meta.json` 目录，download(uid) 读 `<uid>.eml`。
 * 每个 MailboxSource 绑定一个收件地址（spoolRoot/<address>/）。
 */
export class FileMailboxSource implements MailboxSource {
  #dir: string;

  constructor(spoolRoot: string, address: string) {
    this.#dir = addressDir(spoolRoot, address);
  }

  // 无状态实现：M5 适配器每次 poll 后都会 close()（模拟 IMAP 连接关闭），
  // 文件源无资源可释放 —— close 为 no-op，下次 poll 直接重读目录。
  async list(): Promise<EnvelopeMeta[]> {
    const out: EnvelopeMeta[] = [];
    for (const name of readdirSync(this.#dir)) {
      const m = META_RE.exec(name);
      if (m === null) continue;
      const uid = Number(m[1]);
      const eml = join(this.#dir, `${m[1]}.eml`);
      if (!existsSync(eml)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.#dir, name), 'utf8')) as MailMeta;
        out.push({
          uid,
          size: statSync(eml).size,
          messageId: meta.messageId,
          ...(meta.inReplyTo !== undefined ? { inReplyTo: meta.inReplyTo } : {}),
        });
      } catch {
        // 半写状态的元数据跳过（原子写入保证要么完整要么不存在，这里防御损坏文件）
      }
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  async download(uid: number): Promise<Buffer> {
    const eml = join(this.#dir, `${uid}.eml`);
    if (!existsSync(eml)) throw new Error(`FileMailboxSource: no message with uid ${uid}`);
    return readFileSync(eml);
  }

  async close(): Promise<void> {
    /* no-op：无状态 */
  }
}

/**
 * 文件信箱发件侧：send() 渲染 RFC 822 写入收件地址的子目录。
 * uid = 目标目录内当前最大 uid + 1；meta 与 eml 均为原子写入。
 */
export class FileSendTransport implements SendTransport {
  #spoolRoot: string;
  #fromAddress: string;

  constructor(spoolRoot: string, fromAddress: string) {
    this.#spoolRoot = spoolRoot;
    this.#fromAddress = fromAddress;
  }

  async send(payload: SendPayload): Promise<void> {
    const dir = addressDir(this.#spoolRoot, payload.to);
    let maxUid = 0;
    for (const name of readdirSync(dir)) {
      const m = EML_RE.exec(name);
      if (m !== null) maxUid = Math.max(maxUid, Number(m[1]));
    }
    const uid = maxUid + 1;
    const messageId = `<maildrop-${uid}-${Math.random().toString(36).slice(2, 10)}@trade.local>`;
    const source = renderRawMessage({ ...payload, from: payload.from ?? this.#fromAddress }, messageId);
    const meta: MailMeta = { uid, messageId, ...(payload.inReplyTo !== undefined ? { inReplyTo: payload.inReplyTo } : {}) };
    const emlTmp = join(dir, `${uid}.eml.tmp`);
    const metaTmp = join(dir, `${uid}.meta.json.tmp`);
    writeFileSync(emlTmp, source);
    writeFileSync(metaTmp, JSON.stringify(meta));
    renameSync(emlTmp, join(dir, `${uid}.eml`));
    renameSync(metaTmp, join(dir, `${uid}.meta.json`));
  }

  async close(): Promise<void> {
    /* no-op：无状态 */
  }
}
