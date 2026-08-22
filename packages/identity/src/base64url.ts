/**
 * RFC 4648 §5 base64url (URL-safe, no padding) encoding, implemented locally
 * so the package keeps a zero-runtime-dependency surface besides noble.
 * Output matches `Buffer.toString('base64url')` / `btoa` modulo the
 * `-`/`_` alphabet and missing `=` padding.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]!] = i;

/** Encode bytes as unpadded base64url. */
export function b64uEncode(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += ALPHABET[b2 & 0x3f]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const b0 = bytes[i]!;
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[(b0 & 0x03) << 4]!;
  } else if (rem === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += ALPHABET[(b1 & 0x0f) << 2]!;
  }
  return out;
}

/** Decode unpadded (or padded) base64url into bytes. */
export function b64uDecode(input: string): Uint8Array {
  const s = input.replace(/=+$/, '');
  if (s.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = LOOKUP[s[i]!];
    if (v === undefined) {
      throw new TypeError('base64url: invalid character ' + JSON.stringify(s[i]));
    }
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
