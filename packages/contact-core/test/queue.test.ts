import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWakeQueue, type InboundEvent } from '../src/index.js';

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    provider: 'agentmail',
    eventId: 'evt_1',
    inboxId: 'seller@example.net',
    messageRef: {
      provider: 'agentmail',
      inboxId: 'seller@example.net',
      messageId: 'msg_1',
    },
    threadId: 'thread_1',
    from: 'buyer@example.net',
    subject: 'Inquiry',
    tradeId: 'trade_1',
    receivedAt: '2026-08-24T00:00:00.000Z',
    size: 123,
    trust: 'untrusted',
    ...overrides,
  };
}

async function makeQueue(): Promise<FileWakeQueue> {
  const dir = await mkdtemp(join(tmpdir(), 'contact-queue-'));
  temporaryDirs.push(dir);
  return new FileWakeQueue(dir);
}

describe('FileWakeQueue', () => {
  it('persists metadata only with private filesystem permissions', async () => {
    const queue = await makeQueue();
    const result = await queue.enqueue(event(), new Date('2026-08-24T00:00:01.000Z'));

    expect(result.accepted).toBe(true);
    const raw = await readFile(result.path, 'utf8');
    expect(raw).not.toContain('body');
    expect(raw).not.toContain('html');
    expect(JSON.parse(raw)).toMatchObject({
      version: 'agent-trade-wake-task/0.1',
      type: 'contact.message.received',
      trust: 'untrusted',
      next_actions: ['contact_message_get', 'trade_get_status'],
    });
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat(queue.pendingDir)).mode & 0o777).toBe(0o700);
  });

  it('deduplicates concurrent provider redelivery by message identity', async () => {
    const queue = await makeQueue();
    const results = await Promise.all(Array.from({ length: 8 }, () => queue.enqueue(event())));
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(await queue.listPending()).toHaveLength(1);
  });

  it('keeps acknowledged tasks recoverable and continues deduplicating them', async () => {
    const queue = await makeQueue();
    const first = await queue.enqueue(event());
    const donePath = await queue.ack(first.task.task_id);

    expect(donePath).toContain('/done/');
    expect(await queue.listPending()).toEqual([]);
    expect(await queue.get(first.task.task_id)).toMatchObject({ task_id: first.task.task_id });
    expect((await queue.enqueue(event())).accepted).toBe(false);
  });

  it('does not permit task ids to escape the queue directory', async () => {
    const queue = await makeQueue();
    await expect(queue.ack('../outside')).rejects.toThrow('invalid WakeTask id');
  });
});
