import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMailAdapter } from '../src/adapter.js';
import type { MailConfig } from '../src/types.js';
import { FakeMailbox, FakeTransport } from './helpers/fake.js';
import { buildRawMessage } from './helpers/raw.js';

const BASE_CONFIG = {
  smtpUrl: 'smtp://trader:secret@127.0.0.1:3025',
  imapUrl: 'imap://trader:secret@127.0.0.1:3143',
};

interface Harness {
  adapter: ReturnType<typeof createMailAdapter>;
  mailbox: FakeMailbox;
  transport: FakeTransport;
  inboxDir: string;
  seenPath: string;
  dir: string;
  warnings: string[];
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeHarness(overrides: Partial<MailConfig> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'email-unit-'));
  dirs.push(dir);
  const inboxDir = join(dir, 'inbox');
  const seenPath = join(dir, 'seen.json');
  const mailbox = new FakeMailbox();
  const transport = new FakeTransport();
  const warnings: string[] = [];
  const adapter = createMailAdapter(
    { ...BASE_CONFIG, inboxDir, seenStorePath: seenPath, ...overrides },
    { source: mailbox, transport, warn: (m) => warnings.push(m) },
  );
  return { adapter, mailbox, transport, inboxDir, seenPath, dir, warnings };
}

describe('email adapter — poll (parse / correlate / land)', () => {
  it('parses, correlates X-Trade-Id and lands attachments in inboxDir', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<m1@example.com>',
      source: buildRawMessage({
        from: 'alice@example.com',
        messageId: '<m1@example.com>',
        tradeId: 'T-42',
        text: 'accept the deal',
        attachments: [{ filename: 'deal.signed', content: Buffer.from('SIGNED-BYTES') }],
      }),
    });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      tradeId: 'T-42',
      from: 'alice@example.com',
      messageId: '<m1@example.com>',
    });
    expect(msgs[0].text).toContain('accept the deal');
    expect(msgs[0].attachments).toEqual([
      { filename: 'deal.signed', path: join(h.inboxDir, 'deal.signed') },
    ]);
    expect(await readFile(join(h.inboxDir, 'deal.signed'), 'utf8')).toBe('SIGNED-BYTES');
    // the body was downloaded exactly once
    expect(h.mailbox.downloads).toEqual([1]);
    expect(h.mailbox.closed).toBe(true);
  });

  it('surfaces In-Reply-To on InboundMsg', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<m2@example.com>',
      source: buildRawMessage({
        messageId: '<m2@example.com>',
        inReplyTo: '<m1@example.com>',
        tradeId: 'T-1',
        text: 'reply',
      }),
    });
    const msgs = await h.adapter.poll();
    expect(msgs[0].inReplyTo).toBe('<m1@example.com>');
  });

  it('falls back to the envelope messageId when the header is absent', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: 'envelope-id-1',
      source: buildRawMessage({ tradeId: 'T-1', text: 'no message-id header' }),
    });
    const msgs = await h.adapter.poll();
    expect(msgs[0].messageId).toBe('envelope-id-1');
  });
});

describe('email adapter — idempotency', () => {
  it('delivers each message once across polls within an instance', async () => {
    const h = await makeHarness();
    const source = buildRawMessage({ messageId: '<m@x>', tradeId: 'T-1', text: 'once' });
    h.mailbox.messages.push({ uid: 1, messageId: '<m@x>', source });

    expect(await h.adapter.poll()).toHaveLength(1);
    expect(await h.adapter.poll()).toHaveLength(0);
    // the second poll must not re-download
    expect(h.mailbox.downloads).toEqual([1]);
  });

  it('persists seen Message-IDs to seenStorePath across adapter instances', async () => {
    const h = await makeHarness();
    const source = buildRawMessage({ messageId: '<m@x>', tradeId: 'T-1', text: 'once' });
    h.mailbox.messages.push({ uid: 1, messageId: '<m@x>', source });

    await h.adapter.poll();
    await h.adapter.close();

    // fresh adapter, same seenStorePath + inboxDir, same mailbox contents
    const h2 = await makeHarness({ seenStorePath: h.seenPath, inboxDir: h.inboxDir });
    h2.mailbox.messages.push({ uid: 1, messageId: '<m@x>', source });
    const msgs = await h2.adapter.poll();
    expect(msgs).toHaveLength(0);
    expect(h2.mailbox.downloads).toEqual([]);
  });

  it('absorbs duplicate deliveries with the same Message-ID in the mailbox', async () => {
    const h = await makeHarness();
    const source = buildRawMessage({ messageId: '<dup@x>', tradeId: 'T-1', text: 'dup' });
    // same Message-ID delivered twice (retransmission)
    h.mailbox.messages.push({ uid: 1, messageId: '<dup@x>', source });
    h.mailbox.messages.push({ uid: 2, messageId: '<dup@x>', source });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe('<dup@x>');
    // only the first copy was downloaded
    expect(h.mailbox.downloads).toEqual([1]);
  });
});

describe('email adapter — size gating', () => {
  it('skips oversized mail without downloading the body', async () => {
    const h = await makeHarness({ maxMailBytes: 1024 });
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<big@x>',
      // RFC822.SIZE over the limit; no source present — a download call would throw
      size: 4096,
    });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(0);
    expect(h.mailbox.downloads).toEqual([]);
    expect(h.warnings.some((w) => w.includes('maxMailBytes'))).toBe(true);
  });

  it('delivers mail exactly at the size limit', async () => {
    const h = await makeHarness({ maxMailBytes: 8 });
    const source = buildRawMessage({ messageId: '<ok@x>', tradeId: 'T-1', text: 'x' });
    h.mailbox.messages.push({ uid: 1, messageId: '<ok@x>', size: 8, source });
    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
  });

  it('uses the default 10 MiB mail limit when not configured', async () => {
    const h = await makeHarness();
    const source = buildRawMessage({ messageId: '<ok@x>', tradeId: 'T-1', text: 'x' });
    h.mailbox.messages.push({ uid: 1, messageId: '<ok@x>', size: 5 * 1024 * 1024, source });
    expect(await h.adapter.poll()).toHaveLength(1);
  });

  it('rejects attachments over maxAttachmentBytes without writing them', async () => {
    const h = await makeHarness({ maxAttachmentBytes: 32 });
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<att@x>',
      source: buildRawMessage({
        messageId: '<att@x>',
        tradeId: 'T-1',
        text: 'has a big attachment',
        attachments: [
          { filename: 'ok.txt', content: Buffer.from('small') },
          { filename: 'big.bin', content: Buffer.alloc(1024, 1) },
        ],
      }),
    });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
    // the oversized attachment was refused, the small one landed
    expect(msgs[0].attachments).toEqual([{ filename: 'ok.txt', path: join(h.inboxDir, 'ok.txt') }]);
    expect(await readdir(h.inboxDir)).toEqual(['ok.txt']);
    expect(h.warnings.some((w) => w.includes('maxAttachmentBytes'))).toBe(true);
  });

  it('uses the default 2 MiB attachment limit when not configured', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<att@x>',
      source: buildRawMessage({
        messageId: '<att@x>',
        attachments: [{ filename: 'mid.bin', content: Buffer.alloc(1024 * 1024, 2) }],
      }),
    });
    const msgs = await h.adapter.poll();
    expect(msgs[0].attachments).toHaveLength(1);
  });
});

describe('email adapter — attachment path traversal', () => {
  it('sanitizes traversal filenames and keeps everything inside inboxDir', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<evil@x>',
      source: buildRawMessage({
        messageId: '<evil@x>',
        tradeId: 'T-1',
        attachments: [
          { filename: '../../evil.sh', content: Buffer.from('#!/bin/sh\n') },
          { filename: '/etc/cron.d/pwn', content: Buffer.from('pwn') },
          { filename: '..\\..\\..\\win.exe', content: Buffer.from('MZ') },
          { filename: 'C:\\Temp\\drive.dll', content: Buffer.from('DLL') },
        ],
      }),
    });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
    const names = msgs[0].attachments.map((a) => a.filename).sort();
    expect(names).toEqual(['drive.dll', 'evil.sh', 'pwn', 'win.exe']);

    const inboxDirResolved = resolve(h.inboxDir);
    for (const a of msgs[0].attachments) {
      const p = resolve(a.path);
      expect(p.startsWith(inboxDirResolved + sep)).toBe(true);
      expect(await stat(p).then((s) => s.isFile())).toBe(true);
    }
    // nothing escaped: inboxDir contains exactly the four sanitized files
    expect((await readdir(h.inboxDir)).sort()).toEqual(['drive.dll', 'evil.sh', 'pwn', 'win.exe']);
    // nothing was written next to the inbox dir or to the tmp root
    const parentEntries = await readdir(h.dir);
    expect(parentEntries).not.toContain('evil.sh');
    expect(parentEntries).not.toContain('win.exe');
    expect(parentEntries).not.toContain('pwn');
  });

  it('deduplicates colliding attachment names with -1/-2 suffixes', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<dup-att@x>',
      source: buildRawMessage({
        messageId: '<dup-att@x>',
        attachments: [
          { filename: 'a.txt', content: Buffer.from('first') },
          { filename: 'a.txt', content: Buffer.from('second') },
        ],
      }),
    });
    const msgs = await h.adapter.poll();
    expect(msgs[0].attachments.map((a) => a.filename).sort()).toEqual(['a-1.txt', 'a.txt']);
    expect(await readFile(join(h.inboxDir, 'a.txt'), 'utf8')).toBe('first');
    expect(await readFile(join(h.inboxDir, 'a-1.txt'), 'utf8')).toBe('second');
  });
});

describe('email adapter — hostile-mail robustness', () => {
  it('skips a message whose download fails and still delivers the rest', async () => {
    const h = await makeHarness();
    // uid 1 has no source: FakeMailbox.download throws for it
    h.mailbox.messages.push({ uid: 1, messageId: '<boom@x>' });
    h.mailbox.messages.push({
      uid: 2,
      messageId: '<ok@x>',
      source: buildRawMessage({ messageId: '<ok@x>', tradeId: 'T-1', text: 'fine' }),
    });

    const msgs = await h.adapter.poll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].messageId).toBe('<ok@x>');
    expect(h.warnings.some((w) => w.includes('<boom@x>'))).toBe(true);
    // the failed message was never marked seen: the next poll retries it
    // (and fails again with a warning) while the delivered one is skipped
    expect(await h.adapter.poll()).toHaveLength(0);
    expect(h.mailbox.downloads).toEqual([1, 2, 1]);
  });

  it('truncates an over-long attachment filename instead of failing the write', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<long@x>',
      source: buildRawMessage({
        messageId: '<long@x>',
        tradeId: 'T-1',
        attachments: [{ filename: `${'x'.repeat(300)}.bin`, content: Buffer.from('data') }],
      }),
    });

    const msgs = await h.adapter.poll();
    expect(msgs[0].attachments).toHaveLength(1);
    const { filename, path } = msgs[0].attachments[0];
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(96);
    expect(filename.endsWith('.bin')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('data');
  });
});

describe('email adapter — send', () => {
  it('always attaches X-Trade-Id, optional inReplyTo and attachment bytes', async () => {
    const h = await makeHarness();
    await h.adapter.send({
      to: 'bob@example.com',
      tradeId: 'T-7',
      subject: 'counter-offer',
      text: '30% off',
      inReplyTo: '<m-6@example.com>',
      attachments: [{ filename: 'counter.signed', data: new Uint8Array([1, 2, 3, 250]) }],
    });

    expect(h.transport.sent).toHaveLength(1);
    const sent = h.transport.sent[0];
    expect(sent.to).toBe('bob@example.com');
    expect(sent.subject).toBe('counter-offer');
    expect(sent.text).toBe('30% off');
    expect(sent.headers['X-Trade-Id']).toBe('T-7');
    expect(sent.inReplyTo).toBe('<m-6@example.com>');
    expect(sent.attachments).toEqual([
      { filename: 'counter.signed', content: Buffer.from([1, 2, 3, 250]) },
    ]);
    expect(sent.from).toBe('trader@127.0.0.1');
  });

  it('derives the envelope sender from the SMTP URL user', async () => {
    const h = await makeHarness({ smtpUrl: 'smtp://alice%40example.com:secret@host:25' });
    await h.adapter.send({ to: 'b@c.d', tradeId: 'T-0', subject: 's' });
    expect(h.transport.sent[0].from).toBe('alice@example.com');
  });
});

describe('email adapter — lifecycle', () => {
  it('close() flushes the seen store and closes transport and source', async () => {
    const h = await makeHarness();
    h.mailbox.messages.push({
      uid: 1,
      messageId: '<life@x>',
      source: buildRawMessage({ messageId: '<life@x>', tradeId: 'T-1', text: 'x' }),
    });
    await h.adapter.poll();
    await h.adapter.close();

    expect(h.transport.closed).toBe(true);
    const persisted = JSON.parse(await readFile(h.seenPath, 'utf8'));
    expect(persisted).toContain('<life@x>');
  });
});
