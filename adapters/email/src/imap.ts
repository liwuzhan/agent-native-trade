import { ImapFlow } from 'imapflow';
import { parseMailUrl } from './url.js';

/** Lightweight per-message metadata obtained without downloading bodies. */
export interface EnvelopeMeta {
  uid: number;
  /** RFC822.SIZE of the message. */
  size: number;
  messageId: string;
  inReplyTo?: string;
}

/** Record of one IMAP fetch command, for asserting what was (not) downloaded. */
export interface FetchRecord {
  phase: 'list' | 'download';
  /** Items requested, e.g. `['uid','size','envelope']` or `['uid','source']`. */
  items: string[];
  uid?: number;
}

/** Abstraction over an IMAP mailbox; unit tests substitute an in-memory fake. */
export interface MailboxSource {
  /** Envelope + RFC822.SIZE for every message, no body download. */
  list(): Promise<EnvelopeMeta[]>;
  /** Download the full raw RFC 822 source of one message by UID. */
  download(uid: number): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * Real IMAP mailbox backed by imapflow. One connection is opened lazily per
 * poll and closed by {@link close}; the size gate lives in the adapter (list()
 * only ever requests `uid`/`size`/`envelope`, never the source).
 */
export class ImapMailbox implements MailboxSource {
  readonly #url: string;
  readonly #fetchTrace?: (record: FetchRecord) => void;
  #client?: ImapFlow;

  constructor(url: string, fetchTrace?: (record: FetchRecord) => void) {
    this.#url = url;
    this.#fetchTrace = fetchTrace;
  }

  async #ensureConnected(): Promise<ImapFlow> {
    if (this.#client) return this.#client;
    const parsed = parseMailUrl(this.#url, 'imap');
    const client = new ImapFlow({
      host: parsed.host,
      port: parsed.port,
      secure: parsed.secure,
      auth: parsed.user ? { user: parsed.user, pass: parsed.pass ?? '' } : undefined,
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen('INBOX');
    this.#client = client;
    return client;
  }

  async list(): Promise<EnvelopeMeta[]> {
    const client = await this.#ensureConnected();
    this.#fetchTrace?.({ phase: 'list', items: ['uid', 'size', 'envelope'] });
    const metas: EnvelopeMeta[] = [];
    for await (const msg of client.fetch('1:*', { uid: true, size: true, envelope: true })) {
      const size = msg.size ?? 0;
      const messageId = msg.envelope?.messageId?.trim() || `imap-uid-${msg.uid}@localhost`;
      metas.push({ uid: msg.uid, size, messageId, inReplyTo: msg.envelope?.inReplyTo || undefined });
    }
    metas.sort((a, b) => a.uid - b.uid);
    return metas;
  }

  async download(uid: number): Promise<Buffer> {
    const client = await this.#ensureConnected();
    this.#fetchTrace?.({ phase: 'download', items: ['uid', 'source'], uid });
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`IMAP message ${uid} disappeared before download`);
    return Buffer.from(msg.source);
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}
