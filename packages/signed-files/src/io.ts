import { jcs } from '@agent-trade/identity';

import type { SignedFile } from './types.js';

/**
 * Storage/transport serialization: deterministic RFC 8785 (JCS) — the same
 * canonical form used to derive body_hash, so serialize(parse(x)) is
 * byte-identical to the original.
 */
export function serialize(file: SignedFile): string {
  return jcs(file);
}

/**
 * Deserialize a JSON text produced by serialize(). Lenient by design: parse
 * only reconstructs the object; all validation happens in verifyFile.
 */
export function parse(text: string): SignedFile {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('parse: expected a JSON object (a signed envelope)');
  }
  return value as SignedFile;
}
