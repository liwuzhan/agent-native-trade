import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileWakeQueue,
  type ContactAdapter,
  type ContactHealth,
  type InboundEvent,
  type ReplyInput,
  type SendInput,
  type SentRef,
  type StoredMessage,
  type WatchHandle,
  type WatchInput,
} from '@agent-trade/contact-core';
import { TradeInboxDaemon, type WakeTrigger } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function event(): InboundEvent {
  return {
    provider: 'agentmail',
    eventId: 'evt_1',
    inboxId: 'seller@example.net',
    messageRef: { provider: 'agentmail', inboxId: 'seller@example.net', messageId: 'msg_1' },
    from: 'buyer@example.net',
    subject: 'Inquiry',
    receivedAt: '2026-08-24T00:00:00.000Z',
    trust: 'untrusted',
  };
}

class FakeAdapter implements ContactAdapter {
  emit: ((event: InboundEvent) => Promise<void>) | undefined;
  closed = false;
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  async send(_input: SendInput): Promise<SentRef> { throw new Error('not used'); }
  async reply(_input: ReplyInput): Promise<SentRef> { throw new Error('not used'); }
  async getMessage(): Promise<StoredMessage> { throw new Error('not used'); }
  async health(): Promise<ContactHealth> { return { ok: true, provider: 'fake' }; }
  async watch(_input: WatchInput, emit: (event: InboundEvent) => Promise<void>): Promise<WatchHandle> {
    this.emit = emit;
    return {
      done: this.done,
      close: async () => { this.resolveDone(); },
    };
  }
  async close(): Promise<void> { this.closed = true; }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('TradeInboxDaemon', () => {
  it('queues once, triggers once, and stops without a polling interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trade-inboxd-'));
    dirs.push(dir);
    const queue = new FileWakeQueue(dir);
    const adapter = new FakeAdapter();
    const notify = vi.fn(async () => undefined);
    const trigger: WakeTrigger = { notify };
    const daemon = new TradeInboxDaemon({
      adapter,
      queue,
      trigger,
      inboxId: 'seller@example.net',
      reconnectInitialMs: 5,
      reconnectMaxMs: 10,
    });

    const running = daemon.run();
    await waitUntil(() => Boolean(adapter.emit));
    await adapter.emit?.(event());
    await adapter.emit?.({ ...event(), eventId: 'redelivered_evt' });
    await waitUntil(async () => (await queue.listPending()).length === 1);
    await waitUntil(() => notify.mock.calls.length === 1);

    expect(notify).toHaveBeenCalledTimes(1);
    await daemon.stop();
    await running;
    expect(adapter.closed).toBe(true);
  });

  it('retains a queued task when a local model trigger fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trade-inboxd-'));
    dirs.push(dir);
    const queue = new FileWakeQueue(dir);
    const adapter = new FakeAdapter();
    const logs: Array<Record<string, unknown>> = [];
    const daemon = new TradeInboxDaemon({
      adapter,
      queue,
      trigger: { notify: async () => { throw new Error('model unavailable'); } },
      inboxId: 'seller@example.net',
      logger: (record) => logs.push(record),
    });

    const running = daemon.run();
    await waitUntil(() => Boolean(adapter.emit));
    await adapter.emit?.(event());
    expect(await queue.listPending()).toHaveLength(1);
    await waitUntil(() => logs.some((record) => record.event === 'wake_task.trigger_failed'));
    expect(logs).toContainEqual(expect.objectContaining({ event: 'wake_task.trigger_failed' }));
    await daemon.stop();
    await running;
  });
});
