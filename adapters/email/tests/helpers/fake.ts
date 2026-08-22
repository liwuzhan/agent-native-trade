/**
 * Test helpers: in-memory MailboxSource and recording SendTransport.
 */
import type { EnvelopeMeta, MailboxSource } from '../../src/imap.js';
import type { SendPayload, SendTransport } from '../../src/smtp.js';

export interface FakeMessage {
  uid: number;
  messageId: string;
  inReplyTo?: string;
  /** Explicit RFC822.SIZE; defaults to the byte length of `source`. */
  size?: number;
  /** Raw source; absent when the message must NOT be downloaded (oversized). */
  source?: Buffer;
}

/** In-memory IMAP mailbox: records every download so tests can assert that
 *  oversized messages were never fetched beyond size/envelope. */
export class FakeMailbox implements MailboxSource {
  messages: FakeMessage[] = [];
  /** UIDs that were actually downloaded (body fetched). */
  downloads: number[] = [];
  listCalls = 0;
  closed = false;

  async list(): Promise<EnvelopeMeta[]> {
    this.listCalls += 1;
    return [...this.messages]
      .sort((a, b) => a.uid - b.uid)
      .map((m) => ({
        uid: m.uid,
        size: m.size ?? m.source?.byteLength ?? 0,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
      }));
  }

  async download(uid: number): Promise<Buffer> {
    this.downloads.push(uid);
    const message = this.messages.find((m) => m.uid === uid);
    if (!message) throw new Error(`FakeMailbox: no message with uid ${uid}`);
    if (!message.source) {
      throw new Error(`FakeMailbox: download(${uid}) called but message has no source`);
    }
    return message.source;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Recording SMTP transport. */
export class FakeTransport implements SendTransport {
  sent: SendPayload[] = [];
  closed = false;

  async send(payload: SendPayload): Promise<void> {
    this.sent.push(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
