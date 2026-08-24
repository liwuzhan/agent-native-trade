import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMailAdapter } from '../../src/adapter.js';
import type { FetchRecord } from '../../src/imap.js';
import type { MailAdapter } from '../../src/types.js';

/**
 * GreenMail integration test. Gated by GREENMAIL=1.
 *
 *   docker compose -f docker-compose.greenmail.yml up -d
 *   GREENMAIL=1 npx vitest run
 *
 * Ports: SMTP 3025, IMAP 3143 (see docker-compose.greenmail.yml).
 * User:   trader / secret / trader@example.com  (format login:pwd@domain).
 */
const ENABLED = process.env.GREENMAIL === '1';
const SMTP_URL = process.env.GREENMAIL_SMTP_URL ?? 'smtp://trader:secret@127.0.0.1:3025';
const IMAP_URL = process.env.GREENMAIL_IMAP_URL ?? 'imap://trader:secret@127.0.0.1:3143';
const TO = 'trader@example.com';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)('GreenMail integration', () => {
  let dir: string;
  let seenPath: string;
  let inboxCounter = 0;
  const adapters: MailAdapter[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'email-greenmail-'));
    seenPath = join(dir, 'seen.json');
  });

  afterAll(async () => {
    for (const a of adapters) {
      await a.close().catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** Each adapter gets its own inboxDir so attachment-landing assertions are isolated. */
  function makeAdapter(
    overrides: { maxMailBytes?: number; maxAttachmentBytes?: number; fetchTrace?: (r: FetchRecord) => void } = {},
  ): { adapter: MailAdapter; inboxDir: string } {
    const inboxDir = join(dir, `inbox-${inboxCounter++}`);
    const adapter = createMailAdapter(
      { smtpUrl: SMTP_URL, imapUrl: IMAP_URL, inboxDir, seenStorePath: seenPath, ...overrides },
      { fetchTrace: overrides.fetchTrace },
    );
    adapters.push(adapter);
    return { adapter, inboxDir };
  }

  /** Poll until `count` new messages arrive or ~10s elapse (GreenMail delivers asynchronously). */
  async function pollUntil(adapter: MailAdapter, count: number): Promise<Awaited<ReturnType<MailAdapter['poll']>>> {
    const deadline = Date.now() + 10_000;
    let result = await adapter.poll();
    while (result.length < count && Date.now() < deadline) {
      await sleep(200);
      result = await adapter.poll();
    }
    return result;
  }

  /** Current INBOX message count, observed with a test-owned client. */
  async function mailboxCount(): Promise<number> {
    const client = new ImapFlow({
      host: '127.0.0.1',
      port: 3143,
      secure: false,
      auth: { user: 'trader', pass: 'secret' },
      logger: false,
    });
    await client.connect();
    try {
      const mailbox = await client.mailboxOpen('INBOX');
      return mailbox.exists;
    } finally {
      await client.logout();
    }
  }

  /** Wait until INBOX grows beyond `previousCount` (new mail delivered). */
  async function waitForMailboxGrowth(previousCount: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await mailboxCount()) > previousCount) return;
      await sleep(300);
    }
    throw new Error('timed out waiting for GreenMail delivery');
  }

  it('round-trips send -> poll with X-Trade-Id, text and a landed attachment', async () => {
    const { adapter, inboxDir } = makeAdapter();
    await adapter.send({
      to: TO,
      tradeId: 'T-GREEN-1',
      subject: 'greenmail roundtrip',
      text: 'hello from the integration test',
      attachments: [{ filename: 'deal.signed', data: new TextEncoder().encode('GREENMAIL-DATA') }],
    });

    const msgs = await pollUntil(adapter, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].tradeId).toBe('T-GREEN-1');
    expect(msgs[0].from).toBe('trader@127.0.0.1');
    expect(msgs[0].text).toContain('hello from the integration test');
    expect(msgs[0].attachments).toEqual([
      { filename: 'deal.signed', path: join(inboxDir, 'deal.signed') },
    ]);
    expect(await readFile(join(inboxDir, 'deal.signed'), 'utf8')).toBe('GREENMAIL-DATA');
  });

  it('writes the X-Trade-Id header literally on the wire', async () => {
    const { adapter } = makeAdapter();
    const before = await mailboxCount();
    await adapter.send({ to: TO, tradeId: 'T-HEADER-9', subject: 'header check', text: 'x' });
    await waitForMailboxGrowth(before);

    // find the delivered message's raw source with a test-owned client
    const client = new ImapFlow({
      host: '127.0.0.1',
      port: 3143,
      secure: false,
      auth: { user: 'trader', pass: 'secret' },
      logger: false,
    });
    await client.connect();
    let raw: string | undefined;
    try {
      await client.mailboxOpen('INBOX');
      for await (const msg of client.fetch('1:*', { source: true })) {
        if (!msg.source) continue;
        const text = Buffer.from(msg.source).toString('utf8');
        if (text.includes('T-HEADER-9')) raw = text;
      }
    } finally {
      await client.logout();
    }
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/^X-Trade-Id: T-HEADER-9$/m);
    expect(raw).toMatch(/^Message-ID: <.+@.+>$/m);
  });

  it('absorbs duplicate deliveries with the same Message-ID (idempotent poll)', async () => {
    const { adapter } = makeAdapter();
    const duplicateId = `<dup-${Date.now()}@example.com>`;

    // send the exact same message twice with a fixed Message-ID
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: 3025,
      secure: false,
      auth: { user: 'trader', pass: 'secret' },
    });
    const mail = {
      from: 'trader@127.0.0.1',
      to: TO,
      subject: 'duplicate',
      text: 'duplicate delivery',
      messageId: duplicateId,
      headers: { 'X-Trade-Id': 'T-DUP-1' },
    };
    await transport.sendMail(mail);
    await transport.sendMail(mail);
    transport.close();

    // both copies arrive in the mailbox; only one InboundMsg is delivered
    const first = await pollUntil(adapter, 1);
    expect(first).toHaveLength(1);
    expect(first[0].messageId).toBe(duplicateId);
    // the second copy (same Message-ID) was absorbed, and later polls stay empty
    expect(await adapter.poll()).toHaveLength(0);
  });

  it('rejects oversized mail without ever downloading the body (only SIZE/HEADER fetches)', async () => {
    const records: FetchRecord[] = [];
    const { adapter } = makeAdapter({ maxMailBytes: 2048, fetchTrace: (r) => records.push(r) });

    const before = await mailboxCount();
    await adapter.send({
      to: TO,
      tradeId: 'T-BIG-1',
      subject: 'too big',
      text: 'x',
      attachments: [{ filename: 'big.bin', data: new Uint8Array(Buffer.alloc(64 * 1024, 7)) }],
    });

    await waitForMailboxGrowth(before);
    const msgs = await adapter.poll();
    expect(msgs).toHaveLength(0);

    // the oversized message was listed (size/envelope only) but never downloaded:
    // no source fetch for any uid
    expect(records.filter((r) => r.phase === 'list').length).toBeGreaterThan(0);
    expect(records.filter((r) => r.phase === 'download')).toEqual([]);
    for (const r of records) {
      expect(r.items).not.toContain('source');
    }
  });

  it('rejects oversized attachments and keeps the message otherwise intact', async () => {
    const { adapter, inboxDir } = makeAdapter({ maxAttachmentBytes: 128 });
    await adapter.send({
      to: TO,
      tradeId: 'T-ATT-1',
      subject: 'big attachment',
      text: 'still readable',
      attachments: [
        { filename: 'ok.txt', data: new TextEncoder().encode('small') },
        { filename: 'big.bin', data: new Uint8Array(Buffer.alloc(4096, 1)) },
      ],
    });

    const msgs = await pollUntil(adapter, 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].tradeId).toBe('T-ATT-1');
    expect(msgs[0].text).toContain('still readable');
    // only the small attachment landed; the oversized one was refused
    expect(msgs[0].attachments).toEqual([{ filename: 'ok.txt', path: join(inboxDir, 'ok.txt') }]);
    expect((await readdir(inboxDir)).sort()).toEqual(['ok.txt']);
  });
});
