import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { parseMailUrl } from './url.js';

/** Normalized payload handed to the transport (adapter maps OutboundMsg onto it). */
export interface SendPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  headers: Record<string, string>;
  attachments?: { filename: string; content: Buffer }[];
}

/** Abstraction over SMTP sending; unit tests substitute a recording fake. */
export interface SendTransport {
  send(payload: SendPayload): Promise<void>;
  close(): Promise<void>;
}

/** Real SMTP transport backed by nodemailer. */
export class NodemailerTransport implements SendTransport {
  readonly #transport: Transporter;

  constructor(smtpUrl: string) {
    const smtp = parseMailUrl(smtpUrl, 'smtp');
    this.#transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
    });
  }

  async send(payload: SendPayload): Promise<void> {
    await this.#transport.sendMail({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      inReplyTo: payload.inReplyTo,
      headers: payload.headers,
      attachments: payload.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
    });
  }

  async close(): Promise<void> {
    this.#transport.close();
  }
}
