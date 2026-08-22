/**
 * RFC 9562 UUIDv7 (time-ordered, random suffix). M6 needs v7 for voucher ids
 * (`TEST-VOUCHER-<uuid v7>`, card rule) and for TRADE_EVENT `event_id`; M7
 * uses the same scheme for `task_id` (declared in its card). No dependency is
 * required — 48-bit big-endian unix-ms timestamp, version nibble 7, variant
 * bits `10`, remaining 74 bits CSPRNG.
 */

import { randomBytes } from 'node:crypto';

export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  const ms = BigInt(Math.trunc(now));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  const rand = randomBytes(10);
  bytes.set(rand, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Regex for a well-formed uuid v7 (used by tests to pin the version nibble). */
export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
