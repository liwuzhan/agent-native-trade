import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { ImapMailbox, type FetchRecord, type MailboxSource } from './imap.js';
import { parseRaw, type ParsedAttachment } from './parse.js';
import { sanitizeFilename } from './sanitize.js';
import { SeenStore } from './seen.js';
import { NodemailerTransport, type SendPayload, type SendTransport } from './smtp.js';
import type { InboundMsg, MailAdapter, MailConfig, OutboundMsg } from './types.js';
import { deriveFromAddress } from './url.js';

/** Default max mail size before the body is downloaded (10 MiB). */
export const DEFAULT_MAX_MAIL_BYTES = 10 * 1024 * 1024;
/** Default max attachment size before it is refused (2 MiB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/**
 * Optional dependency injection seam for tests (in-memory mailbox, recording
 * transport, custom seen store). Only used by unit/integration tests; the
 * public contract per the module card is `createMailAdapter(config)`.
 */
export interface AdapterDeps {
  source?: MailboxSource;
  transport?: SendTransport;
  seen?: SeenStore;
  /** Observe IMAP fetch commands (integration test asserts size gating). */
  fetchTrace?: (record: FetchRecord) => void;
  /** Log sink; defaults to console.warn. */
  warn?: (message: string) => void;
}

export class EmailAdapter implements MailAdapter {
  readonly #config: MailConfig;
  readonly #maxMailBytes: number;
  readonly #maxAttachmentBytes: number;
  readonly #inboxDir: string;
  readonly #from: string;
  #source: MailboxSource;
  #transport: SendTransport;
  #seen: SeenStore | null;
  readonly #warn: (message: string) => void;

  constructor(config: MailConfig, deps: AdapterDeps = {}) {
    this.#config = config;
    this.#maxMailBytes = config.maxMailBytes ?? DEFAULT_MAX_MAIL_BYTES;
    this.#maxAttachmentBytes = config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.#inboxDir = config.inboxDir;
    this.#from = deriveFromAddress(config.smtpUrl);
    this.#source = deps.source ?? new ImapMailbox(config.imapUrl, deps.fetchTrace);
    this.#transport = deps.transport ?? new NodemailerTransport(config.smtpUrl);
    this.#seen = deps.seen ?? null;
    this.#warn = deps.warn ?? ((message: string) => console.warn(`[email] ${message}`));
  }

  async send(msg: OutboundMsg): Promise<void> {
    const payload: SendPayload = {
      from: this.#from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text ?? '',
      inReplyTo: msg.inReplyTo,
      headers: { 'X-Trade-Id': msg.tradeId },
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.data) })),
    };
    await this.#transport.send(payload);
  }

  /**
   * Poll the IMAP inbox. Hard rules:
   * 1. messages larger than maxMailBytes are skipped **without** downloading
   *    the body (only uid/size/envelope were ever fetched);
   * 2. attachments larger than maxAttachmentBytes are refused and never
   *    written;
   * 3. already-seen Message-IDs (persisted in seenStorePath) are not
   *    delivered again.
   */
  async poll(): Promise<InboundMsg[]> {
    const seen = await this.#ensureSeen();
    try {
      const metas = await this.#source.list();
      const out: InboundMsg[] = [];
      for (const meta of metas) {
        if (meta.size > this.#maxMailBytes) {
          this.#warn(
            `skipping message ${meta.messageId}: ${meta.size} bytes > maxMailBytes ${this.#maxMailBytes}`,
          );
          continue;
        }
        if (seen.has(meta.messageId)) {
          continue;
        }
        const raw = await this.#source.download(meta.uid);
        const parsed = await parseRaw(raw);
        const messageId = parsed.messageId || meta.messageId;
        const attachments = await this.#landAttachments(parsed.attachments);
        out.push({
          tradeId: parsed.tradeId,
          from: parsed.from,
          messageId,
          inReplyTo: parsed.inReplyTo,
          text: parsed.text,
          attachments,
        });
        seen.add(messageId);
      }
      await seen.save();
      return out;
    } finally {
      await this.#source.close();
    }
  }

  async #ensureSeen(): Promise<SeenStore> {
    if (!this.#seen) {
      this.#seen = await SeenStore.open(this.#config.seenStorePath);
    }
    return this.#seen;
  }

  async #landAttachments(attachments: ParsedAttachment[]): Promise<InboundMsg['attachments']> {
    const landed: InboundMsg['attachments'] = [];
    await mkdir(this.#inboxDir, { recursive: true });
    for (const a of attachments) {
      if (a.content.byteLength > this.#maxAttachmentBytes) {
        this.#warn(
          `rejecting attachment "${a.filename}": ${a.content.byteLength} bytes > maxAttachmentBytes ${this.#maxAttachmentBytes}`,
        );
        continue;
      }
      const filename = sanitizeFilename(a.filename);
      const dest = await this.#uniquePath(filename);
      await writeFile(dest, a.content);
      landed.push({ filename: basename(dest), path: dest });
    }
    return landed;
  }

  /** Pick a path inside inboxDir; append `-1`, `-2`, ... on name collisions. */
  async #uniquePath(filename: string): Promise<string> {
    const dir = resolve(this.#inboxDir);
    const first = resolve(dir, filename);
    if (first !== dir && !first.startsWith(dir + sep)) {
      // Defense in depth — sanitizeFilename already removed all separators.
      throw new Error(`attachment path escapes inboxDir: "${filename}"`);
    }
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let candidate = first;
    let n = 1;
    while (await exists(candidate)) {
      candidate = resolve(dir, `${stem}-${n}${ext}`);
      n += 1;
    }
    return candidate;
  }

  async close(): Promise<void> {
    await this.#seen?.save();
    await this.#transport.close();
    await this.#source.close();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Build an adapter from a {@link MailConfig}. */
export function createMailAdapter(config: MailConfig, deps: AdapterDeps = {}): MailAdapter {
  return new EmailAdapter(config, deps);
}
