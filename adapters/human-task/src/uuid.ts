/**
 * RFC 9562 UUIDv7 — time-ordered, sortable identifiers.
 *
 * Layout (128 bits, big-endian):
 *   bits  0..47  unix_ts_ms (48-bit milliseconds since the Unix epoch)
 *   bits 48..51  version (0b0111 = 7)
 *   bits 52..63  rand_a (12 random bits)
 *   bits 64..65  variant (0b10)
 *   bits 66..127 rand_b (62 random bits)
 *
 * The 48-bit timestamp prefix makes uuidv7(a) < uuidv7(b) lexicographically
 * whenever a < b, which the local-store index and event replay rely on.
 */

import { randomBytes } from 'node:crypto';

/** Canonical v7 form: version nibble `7`, variant nibble `[8-9a-b]`. */
export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HEX = '0123456789abcdef';

/** Time range that fits the 48-bit field (~year 10889); enforced for clarity. */
const MAX_48BIT = 0x1_0000_0000_0000;

/**
 * Generate a UUIDv7 string. `now` defaults to `Date.now()` and is injectable
 * for deterministic tests.
 */
export function uuidv7(now: number = Date.now()): string {
  const ms = Math.trunc(now);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= MAX_48BIT) {
    throw new RangeError(`uuidv7: timestamp ${now} does not fit the 48-bit millisecond field`);
  }

  const bytes = randomBytes(16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 48-bit field = bytes 0..5: high 32 bits in bytes 0..3, low 16 bits in bytes 4..5.
  view.setUint32(0, Math.floor(ms / 0x1_0000));
  view.setUint16(4, ms & 0xffff);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version = 7 (high nibble of byte 6)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant = 10 (top 2 bits of byte 8)

  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += HEX[bytes[i]! >> 4] + HEX[bytes[i]! & 0x0f];
  }
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  );
}
