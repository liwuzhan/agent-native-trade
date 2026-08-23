/**
 * provider.ts — DSH daemon 的联系 provider 层（runtime bridge contract 的
 * 工具后端）。一个 daemon 一个 ContactAdapter，按行 config / CLI flag 选择：
 *
 *   provider=agentmail  真实邮箱：AgentMail REST（send/reply/getMessage/health）。
 *                       apiKey 只从环境变量读（contactApiKeyEnv，缺省
 *                       AGENTMAIL_API_KEY），inboxId 必配。**不 watch**：
 *                       长连接与 WakeTask 生成是 trade-inboxd 的职责，daemon
 *                       只按需取信/回信 —— 与文档 §8.4 的职责切分一致。
 *   provider=maildrop   本地 file-maildrop loopback（缺省）：send/reply 走
 *                       FileSendTransport（renderRawMessage 渲染 RFC 822），
 *                       getMessage 读 `<uid>.eml` 用 @agent-trade/email 的
 *                       parseRaw 解析（与 M5 同一解析器）。不依赖任何外网。
 *
 * 红线（与 M5/联系运行时一致）：正文/附件是不可信数据 —— parseRaw 只解析
 * 不执行；getMessage 返回附件**引用**（文件名/大小/类型），绝不返回附件内容。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseRaw } from '@agent-trade/email';
import { createAgentMailAdapter } from '@agent-trade/contact-agentmail';
import type {
  ContactAdapter,
  ContactHealth,
  MessageRef,
  ReplyInput,
  SendInput,
  SentRef,
  StoredMessage,
  WatchHandle,
  WatchInput,
} from '@agent-trade/contact-core';

import { FileSendTransport } from '../maildrop.js';

export const PROVIDER_AGENTMAIL = 'agentmail';
export const PROVIDER_MAILDROP = 'maildrop';
export type ContactProviderKind = typeof PROVIDER_AGENTMAIL | typeof PROVIDER_MAILDROP;

export interface ContactProviderOptions {
  provider: ContactProviderKind;
  /** agentmail：apiKey 所在环境变量名（缺省 AGENTMAIL_API_KEY）。 */
  apiKeyEnv?: string;
  /** agentmail：本 daemon 的 inbox id；maildrop：本 daemon 收件地址。 */
  inboxId?: string;
  /** 单封邮件大小门限（agentmail REST 响应上限）。 */
  maxMessageBytes?: number;
  /** maildrop：spool 根（同 M10 --maildrop）。 */
  spoolRoot?: string;
  /** maildrop：发件地址（同 M10 --mail-address）。 */
  fromAddress?: string;
}

const META_RE = /^(\d+)\.meta\.json$/;

interface MailMeta {
  uid: number;
  messageId: string;
  inReplyTo?: string;
}

function contentTypeOf(filename: string): string {
  return filename.endsWith('.json') ? 'application/json' : 'application/octet-stream';
}

/**
 * file-maildrop 的 ContactAdapter：只做 provider-neutral 的确定性收/发/读，
 * 复用 M10 的 FileSendTransport 与 M5 的 parseRaw。watch 不支持（长连接
 * 属 trade-inboxd），调用即明确报错。
 */
export class FileContactAdapter implements ContactAdapter {
  readonly provider = PROVIDER_MAILDROP;

  constructor(
    private readonly spoolRoot: string,
    private readonly fromAddress: string,
    private readonly inboxId: string,
  ) {}

  async send(input: SendInput): Promise<SentRef> {
    this.assertInbox(input.inboxId);
    const transport = new FileSendTransport(this.spoolRoot, this.fromAddress);
    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    let lastMessageId = '';
    for (const to of recipients) {
      lastMessageId = await transport.sendWithId({
        from: this.fromAddress,
        to,
        subject: input.subject,
        text: input.text,
        headers: input.tradeId ? { 'X-Trade-Id': input.tradeId } : {},
      });
    }
    return { ref: { provider: this.provider, inboxId: input.inboxId, messageId: lastMessageId } };
  }

  async reply(input: ReplyInput): Promise<SentRef> {
    this.assertRef(input.messageRef);
    const original = await this.findMessage(input.messageRef);
    const parsed = await parseRaw(original.source);
    const tradeId = input.tradeId ?? (parsed.tradeId !== '' ? parsed.tradeId : undefined);
    const transport = new FileSendTransport(this.spoolRoot, this.fromAddress);
    const messageId = await transport.sendWithId({
      from: this.fromAddress,
      to: parsed.from,
      subject: parsed.subject !== '' ? `Re: ${parsed.subject}` : 'Re:',
      text: input.text,
      inReplyTo: parsed.messageId,
      headers: tradeId ? { 'X-Trade-Id': tradeId } : {},
    });
    return { ref: { provider: this.provider, inboxId: this.inboxId, messageId } };
  }

  async getMessage(ref: MessageRef): Promise<StoredMessage> {
    this.assertRef(ref);
    const found = await this.findMessage(ref);
    const parsed = await parseRaw(found.source);
    return {
      ref,
      from: parsed.from,
      to: [this.inboxId],
      ...(parsed.subject !== '' ? { subject: parsed.subject } : {}),
      ...(parsed.text !== '' ? { text: parsed.text } : {}),
      // 本地 loopback 无真实 thread id：以父消息 Message-ID 作线程关联
      ...(parsed.inReplyTo !== undefined ? { threadId: parsed.inReplyTo } : {}),
      size: found.source.length,
      headers: {
        'message-id': parsed.messageId,
        ...(parsed.inReplyTo !== undefined ? { 'in-reply-to': parsed.inReplyTo } : {}),
        ...(parsed.tradeId !== '' ? { 'x-trade-id': parsed.tradeId } : {}),
      },
      attachments: parsed.attachments.map((attachment) => ({
        attachmentId: `${parsed.messageId}/${attachment.filename}`,
        filename: attachment.filename,
        contentType: contentTypeOf(attachment.filename),
        size: attachment.content.length,
      })),
    };
  }

  async watch(_input: WatchInput): Promise<WatchHandle> {
    throw new Error('maildrop contact provider does not support watch(); run trade-inboxd with an agentmail inbox');
  }

  async health(): Promise<ContactHealth> {
    return { ok: true, provider: this.provider };
  }

  async close(): Promise<void> {
    /* 无状态：同 FileMailboxSource/FileSendTransport */
  }

  private assertInbox(inboxId: string): void {
    if (inboxId !== this.inboxId) throw new Error(`contact adapter is scoped to inbox ${this.inboxId}`);
  }

  private assertRef(ref: MessageRef): void {
    if (ref.provider !== this.provider) throw new Error(`message provider must be ${this.provider}`);
    this.assertInbox(ref.inboxId);
  }

  /** 在 spoolRoot/<inboxId>/ 内按 Message-ID 找 `<uid>.eml` + meta（本地演示的确定性查询）。 */
  private async findMessage(ref: MessageRef): Promise<{ source: Buffer; meta: MailMeta }> {
    const dir = join(this.spoolRoot, this.inboxId);
    let best: MailMeta | undefined;
    try {
      for (const name of readdirSync(dir)) {
        const match = META_RE.exec(name);
        if (match === null) continue;
        const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as MailMeta;
        if (meta.messageId === ref.messageId) {
          best = meta;
          break;
        }
      }
    } catch {
      /* 目录不存在 → 未找到 */
    }
    if (best === undefined) throw new Error(`message not found in maildrop inbox: ${ref.messageId}`);
    return { source: readFileSync(join(dir, `${best.uid}.eml`)), meta: best };
  }
}

export function createContactAdapter(opts: ContactProviderOptions): ContactAdapter {
  if (opts.provider === PROVIDER_AGENTMAIL) {
    const apiKeyEnv = opts.apiKeyEnv ?? 'AGENTMAIL_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `contact provider "agentmail" requires the environment variable ${apiKeyEnv} (inbox-scoped AgentMail key)`,
      );
    }
    if (!opts.inboxId) throw new Error('contact provider "agentmail" requires contactInboxId (the AgentMail inbox)');
    return createAgentMailAdapter({
      apiKey,
      inboxId: opts.inboxId,
      maxMessageBytes: opts.maxMessageBytes ?? 10 * 1024 * 1024,
    });
  }

  // provider === 'maildrop'
  const fromAddress = opts.fromAddress ?? 'agent@trade.local';
  const inboxId = opts.inboxId ?? fromAddress;
  if (!opts.spoolRoot) throw new Error('contact provider "maildrop" requires a spool root (--maildrop)');
  return new FileContactAdapter(opts.spoolRoot, fromAddress, inboxId);
}
