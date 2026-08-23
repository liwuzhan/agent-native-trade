/**
 * contact.ts — 联系工具 handlers。
 *
 * trade_contact_seller（M10，M5 邮件适配器接线）：
 *   send：text 非空 → mail.send({to, tradeId, subject, text, inReplyTo})；
 *   poll：poll === true → mail.poll() 返回新邮件摘要（正文截断、附件只给文件名）。
 *
 * contact_message_get / contact_reply / contact_send（runtime bridge contract）：
 *   走 app.contact（provider-neutral ContactAdapter：agentmail REST 或
 *   maildrop loopback），message_ref 形状 = WakeTask.message_ref。
 *   红线：正文/附件是不可信数据 —— 大小门限在 adapter 内，getMessage 只返回
 *   摘要化正文（截断 + 附件引用），绝不返回附件内容、绝不执行邮件内容。
 */

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';
import { assertMessageRefArgs } from './wake.js';

const TEXT_CAP = 120;
const MAX_MSGS = 3;
/** contact_message_get 的正文上限：够模型理解邮件，又防单封巨型正文淹没上下文。 */
const BODY_TEXT_CAP = 64 * 1024;

export async function tradeContactSeller(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const tradeId = typeof args.trade_id === 'string' && args.trade_id.length > 0 ? args.trade_id : undefined;
  if (tradeId === undefined) throw new Error('trade_contact_seller: "trade_id" is required');

  if (args.poll === true) {
    const msgs = await app.mail.poll();
    const summarized = msgs.slice(0, MAX_MSGS).map((m) => ({
      from: m.from,
      message_id: m.messageId,
      ...(m.inReplyTo !== undefined ? { in_reply_to: m.inReplyTo } : {}),
      text: m.text.length > TEXT_CAP ? m.text.slice(0, TEXT_CAP) : m.text,
      attachments: m.attachments.map((a) => ({ filename: a.filename, path: a.path })),
    }));
    return {
      object_id: tradeId,
      new_messages: summarized.length,
      messages: summarized,
      status: 'polled',
    };
  }

  const to = typeof args.to === 'string' && args.to.length > 0 ? args.to : app.mailPeer;
  if (to === undefined) throw new Error('trade_contact_seller: "to" is required (no default counterparty configured)');
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.length === 0) throw new Error('trade_contact_seller: "text" is required in send mode (or set poll=true)');
  const inReplyTo = typeof args.in_reply_to === 'string' && args.in_reply_to.length > 0 ? args.in_reply_to : undefined;

  // 附件：{filename, content} → Uint8Array；content 为字符串或对象（如 DEAL 信封）
  const attachments: { filename: string; data: Uint8Array }[] = [];
  if (args.attachments !== undefined) {
    if (!Array.isArray(args.attachments) || args.attachments.length > 3) {
      throw new Error('trade_contact_seller: "attachments" must be an array of at most 3 items');
    }
    for (const a of args.attachments) {
      if (!isPlainObject(a) || typeof a.filename !== 'string' || a.filename.length === 0) {
        throw new Error('trade_contact_seller: each attachment needs a "filename" string');
      }
      const content = typeof a.content === 'string' ? a.content : a.content === undefined ? '' : JSON.stringify(a.content);
      if (content.length > 256 * 1024) {
        throw new Error('trade_contact_seller: attachment content too large (256 KiB cap)');
      }
      attachments.push({ filename: a.filename, data: new TextEncoder().encode(content) });
    }
  }

  await app.mail.send({
    to,
    tradeId,
    subject,
    text,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  return { object_id: tradeId, to, subject, status: 'sent', attachments: attachments.map((a) => a.filename) };
}

/**
 * contact_message_get：按 WakeTask.message_ref 取回整封邮件（bridge contract）。
 * 返回摘要化正文：text 截断到 BODY_TEXT_CAP、附件只给 {attachment_id, filename,
 * content_type, size} 引用 —— 附件内容绝不进入上下文。
 */
export async function contactMessageGet(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const ref = assertMessageRefArgs(args);
  if (ref.provider !== app.contactProvider) {
    throw new Error(`contact_message_get: daemon is on provider "${app.contactProvider}", message_ref is "${ref.provider}"`);
  }
  const message = await app.contact.getMessage({ provider: ref.provider, inboxId: ref.inboxId, messageId: ref.messageId });
  const text = message.text ?? '';
  const tradeId = message.headers['x-trade-id'];
  return {
    object_id: `message:${ref.provider}:${ref.inboxId}:${ref.messageId}`,
    // bridge 线上形状 = WakeTask.message_ref（snake_case），与输入一致
    message_ref: { provider: message.ref.provider, inbox_id: message.ref.inboxId, message_id: message.ref.messageId },
    from: message.from,
    to: message.to,
    ...(message.subject !== undefined ? { subject: message.subject } : {}),
    ...(tradeId !== undefined && tradeId !== '' ? { trade_id: tradeId } : {}),
    ...(message.threadId !== undefined ? { thread_id: message.threadId } : {}),
    ...(message.receivedAt !== undefined ? { received_at: message.receivedAt } : {}),
    ...(message.size !== undefined ? { size: message.size } : {}),
    text_truncated: text.length > BODY_TEXT_CAP,
    text_size: text.length,
    text: text.length > BODY_TEXT_CAP ? text.slice(0, BODY_TEXT_CAP) : text,
    attachments: message.attachments.map((a) => ({
      attachment_id: a.attachmentId,
      ...(a.filename !== undefined ? { filename: a.filename } : {}),
      ...(a.contentType !== undefined ? { content_type: a.contentType } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    })),
    status: 'read',
  };
}

/** contact_reply：回复 WakeTask 对应邮件（provider adapter 负责线程/头关联）。 */
export async function contactReply(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const ref = assertMessageRefArgs(args);
  if (ref.provider !== app.contactProvider) {
    throw new Error(`contact_reply: daemon is on provider "${app.contactProvider}", message_ref is "${ref.provider}"`);
  }
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.length === 0) throw new Error('contact_reply: "text" is required');
  if (text.length > 256 * 1024) throw new Error('contact_reply: "text" too large (256 KiB cap)');
  const tradeId = typeof args.trade_id === 'string' && args.trade_id.length > 0 ? args.trade_id : undefined;

  const sent = await app.contact.reply({
    messageRef: { provider: ref.provider, inboxId: ref.inboxId, messageId: ref.messageId },
    text,
    ...(tradeId !== undefined ? { tradeId } : {}),
  });
  return {
    object_id: `message:${sent.ref.provider}:${sent.ref.inboxId}:${sent.ref.messageId}`,
    message_ref: { provider: sent.ref.provider, inbox_id: sent.ref.inboxId, message_id: sent.ref.messageId },
    in_reply_to: ref.messageId,
    status: 'replied',
  };
}

/** contact_send：向新联系对象发首条消息（如目录 contact_refs 的 mailto 地址）。 */
export async function contactSend(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const to = args.to;
  const recipients = Array.isArray(to)
    ? to.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : typeof to === 'string' && to.length > 0
      ? [to]
      : [];
  if (recipients.length === 0) throw new Error('contact_send: "to" must be a non-empty address or string array');
  if (recipients.length > 10) throw new Error('contact_send: at most 10 recipients');
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.length === 0) throw new Error('contact_send: "text" is required');
  if (text.length > 256 * 1024) throw new Error('contact_send: "text" too large (256 KiB cap)');
  const tradeId = typeof args.trade_id === 'string' && args.trade_id.length > 0 ? args.trade_id : undefined;

  const sent = await app.contact.send({
    inboxId: app.contactInboxId,
    to: recipients,
    subject,
    text,
    ...(tradeId !== undefined ? { tradeId } : {}),
  });
  return {
    object_id: `message:${sent.ref.provider}:${sent.ref.inboxId}:${sent.ref.messageId}`,
    message_ref: { provider: sent.ref.provider, inbox_id: sent.ref.inboxId, message_id: sent.ref.messageId },
    to: recipients,
    subject,
    status: 'sent',
  };
}
