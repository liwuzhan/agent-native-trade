/**
 * contact.test.ts — contact bridge（runtime bridge contract）逻辑层单测：
 * contact_wake_list/ack + contact_message_get/reply/send 在 maildrop loopback
 * 与 agentmail（stub adapter）两条 provider 路径上的行为。
 *
 * 与 M10 其他测试同风格：直接构造 DshApp 调 handlers，不经过 DSH 运行时。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileWakeQueue } from '@agent-trade/contact-core';
import type { ContactAdapter, InboundEvent, StoredMessage, WakeTask } from '@agent-trade/contact-core';

import { createDshApp } from '../src/app.js';
import type { DshApp } from '../src/app.js';
import { contactMessageGet, contactReply, contactSend } from '../src/handlers/contact.js';
import { contactWakeAck, contactWakeList } from '../src/handlers/wake.js';

interface Harness {
  dir: string;
  app: DshApp;
}

const cleanups: Harness[] = [];

afterEach(() => {
  for (const h of cleanups.splice(0)) {
    try {
      h.app.close();
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

/** 双角色共享 spool 与 wake 队列（买方/卖方各一个 daemon 实例）。 */
function makePair(): { buyer: Harness; seller: Harness } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contact-'));
  const spool = join(dir, 'shared-maildrop');
  const wakeQueue = join(dir, 'contact');
  const buyerApp = createDshApp({
    dir: join(dir, 'buyer'),
    agentId: 'agent_buyer',
    mailAddress: 'buyer@trade.local',
    mailPeer: 'seller@trade.local',
    maildropDir: spool,
    wakeQueueDir: wakeQueue,
  });
  const sellerApp = createDshApp({
    dir: join(dir, 'seller'),
    agentId: 'agent_seller',
    mailAddress: 'seller@trade.local',
    mailPeer: 'buyer@trade.local',
    maildropDir: spool,
    wakeQueueDir: wakeQueue,
  });
  const buyer = { dir, app: buyerApp };
  const seller = { dir, app: sellerApp };
  cleanups.push(buyer, seller);
  return { buyer, seller };
}

async function enqueueWakeTask(queue: FileWakeQueue, event: InboundEvent): Promise<WakeTask> {
  const result = await queue.enqueue(event);
  expect(result.accepted).toBe(true);
  return result.task;
}

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    provider: 'maildrop',
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    inboxId: 'seller@trade.local',
    messageRef: { provider: 'maildrop', inboxId: 'seller@trade.local', messageId: '<maildrop-1-abc@trade.local>' },
    from: 'buyer@trade.local',
    subject: '询价：M8x40 螺栓',
    tradeId: 'trade-9',
    receivedAt: new Date().toISOString(),
    trust: 'untrusted',
    ...overrides,
  };
}

describe('contact bridge — maildrop loopback（买方→卖方→回信）', () => {
  it('contact_send → contact_message_get（对端）→ contact_reply → 回信取回', async () => {
    const { buyer, seller } = makePair();

    // 买方首触（contact_refs 场景）；返回 ref 是发件侧作用域（agentmail 语义同）
    const sent = await contactSend(
      { to: ['seller@trade.local'], subject: '询价', text: 'M8x40 螺栓一箱多少钱？', trade_id: 'trade-9' },
      buyer.app,
    );
    expect(sent.status).toBe('sent');
    const buyerRef = sent.message_ref as { provider: string; inbox_id: string; message_id: string };
    expect(buyerRef.provider).toBe('maildrop');

    // 收件侧 ref 由 WakeTask 送达（inbox_id = 收件箱，同真实 agentmail 流）：
    // 本地 loopback 里投递副本落在卖方目录，同一 message_id
    const sellerRef = { provider: 'maildrop', inbox_id: 'seller@trade.local', message_id: buyerRef.message_id };

    // 卖方按 WakeTask.message_ref 取正文
    const got = await contactMessageGet({ message_ref: sellerRef }, seller.app);
    expect(got.status).toBe('read');
    expect(got.from).toBe('buyer@trade.local');
    expect(got.to).toEqual(['seller@trade.local']);
    expect(got.subject).toBe('询价');
    expect(got.trade_id).toBe('trade-9');
    expect(got.text).toContain('M8x40');
    expect(got.text_truncated).toBe(false);

    // 卖方回信（继承 trade_id）；买方以自己 inbox 作用域的 ref 取回
    const replied = await contactReply({ message_ref: sellerRef, text: '一箱 420 USDC，含税。' }, seller.app);
    expect(replied.status).toBe('replied');
    expect(replied.in_reply_to).toBe(buyerRef.message_id);
    const replyRef = replied.message_ref as { provider: string; inbox_id: string; message_id: string };
    const back = await contactMessageGet(
      { message_ref: { provider: 'maildrop', inbox_id: 'buyer@trade.local', message_id: replyRef.message_id } },
      buyer.app,
    );
    expect(back.from).toBe('seller@trade.local');
    expect(back.text).toContain('420 USDC');
    expect(back.trade_id).toBe('trade-9');
    expect(back.thread_id).toBe(buyerRef.message_id);
  });

  it('contact_message_get 正文超 64 KiB 截断并置 text_truncated', async () => {
    const { buyer, seller } = makePair();
    const bigText = 'x'.repeat(70 * 1024);
    const sent = await contactSend({ to: ['seller@trade.local'], subject: '长文', text: bigText }, buyer.app);
    const ref = sent.message_ref as { message_id: string };
    const got = await contactMessageGet(
      { message_ref: { provider: 'maildrop', inbox_id: 'seller@trade.local', message_id: ref.message_id } },
      seller.app,
    );
    expect(got.text_truncated).toBe(true);
    expect(got.text_size).toBe(bigText.length);
    expect((got.text as string).length).toBe(64 * 1024);
  });

  it('provider 不匹配时报错（maildrop 会话不能取 agentmail 消息）', async () => {
    const { seller } = makePair();
    await expect(
      contactMessageGet(
        { message_ref: { provider: 'agentmail', inbox_id: 'seller@agentmail.to', message_id: 'msg_01' } },
        seller.app,
      ),
    ).rejects.toThrow(/provider/);
  });

  it('附件只返回引用（filename/content_type/size），不返回内容', async () => {
    const { buyer, seller } = makePair();
    // 直接经 FileSendTransport 发带附件的信（contact_send 不带附件 —— 附件只进不出上下文）
    const { FileSendTransport } = await import('../src/maildrop.js');
    const transport = new FileSendTransport(join(buyer.dir, 'shared-maildrop'), 'buyer@trade.local');
    const messageId = await transport.sendWithId({
      from: 'buyer@trade.local',
      to: 'seller@trade.local',
      subject: 'DEAL 草稿',
      text: '请审阅附件。',
      headers: { 'X-Trade-Id': 'trade-10' },
      attachments: [{ filename: 'deal.json', content: Buffer.from('{"secret":"never-in-context"}') }],
    });
    const got = await contactMessageGet(
      { message_ref: { provider: 'maildrop', inbox_id: 'seller@trade.local', message_id: messageId } },
      seller.app,
    );
    expect(Array.isArray(got.attachments)).toBe(true);
    const atts = got.attachments as { attachment_id: string; filename: string; content_type: string; size: number }[];
    expect(atts.length).toBe(1);
    expect(atts[0].filename).toBe('deal.json');
    expect(atts[0].content_type).toBe('application/json');
    expect(atts[0].size).toBe(Buffer.byteLength('{"secret":"never-in-context"}'));
    expect(JSON.stringify(got)).not.toContain('never-in-context');
    expect(got.trade_id).toBe('trade-10');
  });
});

describe('contact bridge — WakeTask 队列（list / ack / inbox 过滤）', () => {
  it('enqueue → list（本箱可见/他箱不可见）→ ack → 幂等 ack', async () => {
    const { buyer, seller } = makePair();
    const task = await enqueueWakeTask(seller.app.wakeQueue, inboundEvent());

    // 卖方能看到本箱任务；买方（另一 inbox）看不到
    const sellerList = await contactWakeList({}, seller.app);
    expect(sellerList.total_pending).toBe(1);
    expect((sellerList.tasks as { task_id: string }[])[0].task_id).toBe(task.task_id);
    const buyerList = await contactWakeList({}, buyer.app);
    expect(buyerList.total_pending).toBe(0);

    // ack：pending → done，二次 ack 幂等
    const acked = await contactWakeAck({ task_id: task.task_id }, seller.app);
    expect(acked.status).toBe('acked');
    expect((await contactWakeList({}, seller.app)).total_pending).toBe(0);
    const again = await contactWakeAck({ task_id: task.task_id }, seller.app);
    expect(again.status).toBe('acked');

    // 跨箱 ack 拒绝
    const other = await enqueueWakeTask(
      seller.app.wakeQueue,
      inboundEvent({
        eventId: 'evt_other',
        messageRef: { provider: 'maildrop', inboxId: 'seller@trade.local', messageId: '<maildrop-2-xyz@trade.local>' },
      }),
    );
    await expect(contactWakeAck({ task_id: other.task_id }, buyer.app)).rejects.toThrow(/inbox/);
  });

  it('list 上限与 limit 参数生效；未知 task_id ack 报错', async () => {
    const { seller } = makePair();
    for (let i = 0; i < 3; i += 1) {
      await enqueueWakeTask(
        seller.app.wakeQueue,
        inboundEvent({
          eventId: `evt_${i}`,
          messageRef: {
            provider: 'maildrop',
            inboxId: 'seller@trade.local',
            messageId: `<maildrop-${i}-x@trade.local>`,
          },
        }),
      );
    }
    const list = await contactWakeList({ limit: 2 }, seller.app);
    expect(list.total_pending).toBe(3);
    expect((list.tasks as unknown[]).length).toBe(2);
    await expect(contactWakeAck({ task_id: 'wake_' + '0'.repeat(32) }, seller.app)).rejects.toThrow(/unknown task_id/);
  });
});

describe('contact bridge — agentmail（stub adapter 接线）', () => {
  function stubApp(): { app: DshApp; calls: string[] } {
    const calls: string[] = [];
    const stub: ContactAdapter = {
      async send(input) {
        calls.push(`send:${Array.isArray(input.to) ? input.to.join(',') : input.to}`);
        return { ref: { provider: 'agentmail', inboxId: input.inboxId, messageId: 'msg_out_1' } };
      },
      async reply(input) {
        calls.push(`reply:${input.messageRef.messageId}`);
        return { ref: { provider: 'agentmail', inboxId: input.messageRef.inboxId, messageId: 'msg_out_2' } };
      },
      async getMessage(ref) {
        calls.push(`get:${ref.messageId}`);
        const message: StoredMessage = {
          ref,
          from: 'buyer@example.net',
          to: ['seller@example.net'],
          subject: '询价',
          text: '一箱多少钱？',
          headers: { 'x-trade-id': 'trade-11' },
          attachments: [{ attachmentId: 'att_1', filename: 'spec.pdf', contentType: 'application/pdf', size: 2048 }],
        };
        return message;
      },
      async watch() {
        throw new Error('watch not used by daemon');
      },
      async health() {
        return { ok: true, provider: 'agentmail' };
      },
      async close() {
        /* noop */
      },
    };
    const app = {
      contact: stub,
      contactProvider: 'agentmail',
      contactInboxId: 'seller@example.net',
    } as unknown as DshApp;
    return { app, calls };
  }

  it('message_get / reply / send 走 provider-neutral 接口并摘要化', async () => {
    const { app, calls } = stubApp();
    const ref = { provider: 'agentmail', inbox_id: 'seller@example.net', message_id: 'msg_in_1' };

    const got = await contactMessageGet({ message_ref: ref }, app);
    expect(got.status).toBe('read');
    expect(got.trade_id).toBe('trade-11');
    expect(got.attachments).toEqual([
      { attachment_id: 'att_1', filename: 'spec.pdf', content_type: 'application/pdf', size: 2048 },
    ]);

    await contactReply({ message_ref: ref, text: '420。' }, app);
    expect(calls).toContain('reply:msg_in_1');

    await contactSend({ to: ['buyer@example.net'], subject: '报价', text: '420 USDC', trade_id: 'trade-11' }, app);
    expect(calls).toContain('send:buyer@example.net');
  });

  it('参数校验：缺 text / 坏 message_ref / 空收件人', async () => {
    const { app } = stubApp();
    const ref = { provider: 'agentmail', inbox_id: 'seller@example.net', message_id: 'msg_in_1' };
    await expect(contactReply({ message_ref: ref }, app)).rejects.toThrow(/text/);
    await expect(contactMessageGet({ message_ref: { inbox_id: 'x', message_id: 'y' } }, app)).rejects.toThrow(/message_ref/);
    await expect(contactSend({ to: [], text: 'hi' }, app)).rejects.toThrow(/"to"/);
    await expect(contactSend({ to: ['a@b.c'], text: '' }, app)).rejects.toThrow(/text/);
  });
});
