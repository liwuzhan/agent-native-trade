/**
 * Mail URL parsing (`smtp://` / `smtps://` / `imap://` / `imaps://`).
 */

export interface MailServerUrl {
  protocol: 'smtp' | 'imap';
  host: string;
  port: number;
  /** true when the URL scheme implies TLS (`smtps` / `imaps`). */
  secure: boolean;
  user?: string;
  pass?: string;
}

const DEFAULT_PORTS = {
  smtp: { plain: 587, secure: 465 },
  imap: { plain: 143, secure: 993 },
} as const;

/** Redact the password of a mail URL so error messages never echo credentials. */
function redactUrlCredentials(url: string): string {
  return url.replace(/(\/\/[^:/@\s]+):[^@/\s]+@/u, '$1:***@');
}

/** Parse and validate a mail server URL for the expected kind. */
export function parseMailUrl(url: string, expected: 'smtp' | 'imap'): MailServerUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`invalid mail URL: ${redactUrlCredentials(url)}`, { cause: err });
  }
  const proto = parsed.protocol.replace(/:$/, '').toLowerCase();
  const isSmtp = proto === 'smtp' || proto === 'smtps';
  const isImap = proto === 'imap' || proto === 'imaps';
  if (!isSmtp && !isImap) {
    throw new Error(`unsupported mail URL protocol "${parsed.protocol}", expected smtp:// or imap://`);
  }
  if ((expected === 'smtp' && !isSmtp) || (expected === 'imap' && !isImap)) {
    throw new Error(`expected a ${expected}:// URL, got ${parsed.protocol}//`);
  }
  if (!parsed.hostname) {
    throw new Error(`mail URL missing host: ${redactUrlCredentials(url)}`);
  }
  const kind = isSmtp ? 'smtp' : 'imap';
  const secure = proto.endsWith('s');
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[kind][secure ? 'secure' : 'plain'];
  return {
    protocol: kind,
    host: parsed.hostname,
    port,
    secure,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    pass: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/**
 * Derive the From address used as SMTP envelope sender from the SMTP URL.
 * `smtp://user@host` -> `user@host`; `smtp://user%40example.com:...` is kept
 * as-is; no user -> `agent@host`.
 */
export function deriveFromAddress(smtpUrl: string): string {
  const parsed = parseMailUrl(smtpUrl, 'smtp');
  if (parsed.user && parsed.user.includes('@')) return parsed.user;
  if (parsed.user) return `${parsed.user}@${parsed.host}`;
  return `agent@${parsed.host}`;
}
