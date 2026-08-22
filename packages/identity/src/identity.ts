import { getPublicKey, hashes, sign as ed25519Sign, verify as ed25519Verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { b64uDecode, b64uEncode } from './base64url.js';

// @noble/ed25519 v3 exposes only async methods by default; sync methods are
// enabled by injecting SHA-512 (see https://github.com/paulmillr/noble-ed25519).
hashes.sha512 = sha512;

export interface Identity {
  /** base64url (43 chars): raw 32-byte Ed25519 public key */
  publicKey: string;
  /** base64url (43 chars): raw 32-byte Ed25519 seed (RFC 8032 private key) */
  secretKey: string;
}

/**
 * Generate a fresh Ed25519 identity from a CSPRNG seed.
 */
export function generateIdentity(): Identity {
  const seed = randomBytes(32);
  const secretKey = b64uEncode(seed);
  return { publicKey: publicKeyFromSeed(secretKey), secretKey };
}

/**
 * Sign `message` (the raw signing_input bytes, per protocol §2) with a
 * base64url-encoded 32-byte seed. Returns a base64url (86 chars) signature.
 */
export function sign(message: Uint8Array, secretKey: string): string {
  return b64uEncode(ed25519Sign(message, b64uDecode(secretKey)));
}

/**
 * Strict RFC 8032 verification. `zip215: false` is explicit on purpose:
 * @noble/ed25519 v3 defaults to the ZIP-215 (cofactored, malleable) criteria,
 * which the protocol rejects (§3 "严格模式"; see also tech-stack V0.4 §6.1).
 */
export function verify(message: Uint8Array, signature: string, publicKey: string): boolean {
  return ed25519Verify(b64uDecode(signature), message, b64uDecode(publicKey), { zip215: false });
}

/**
 * Deterministically derive the base64url public key from a base64url
 * 32-byte seed. Idempotent by construction.
 */
export function publicKeyFromSeed(seed: string): string {
  return b64uEncode(getPublicKey(b64uDecode(seed)));
}
