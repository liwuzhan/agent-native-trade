/**
 * contact.ts — trade_contact_seller（M5 邮件适配器的 DSH 侧接线）。
 *
 * 两种模式：
 *   send：text 非空 → mail.send({to, tradeId, subject, text, inReplyTo})；
 *   poll：poll === true → mail.poll() 返回新邮件摘要（正文截断、附件只给文件名）。
 *
 * 红线：邮件正文/附件是不可信数据 —— 摘要化返回、大小门限在 M5 适配器内
 * （maxMailBytes / maxAttachmentBytes），工具层绝不执行邮件内容。
 */

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';

const TEXT_CAP = 120;
const MAX_MSGS = 3;

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
