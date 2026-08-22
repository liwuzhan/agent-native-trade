import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * SHA-256 of a string (UTF-8 encoded) or a byte array, as lowercase hex
 * without a prefix. This is the `lowerhex` primitive used by the
 * agent-trade/0.2 protocol (`body_hash`, `object_id`, `catalog_hash`).
 */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return bytesToHex(sha256(data));
}
