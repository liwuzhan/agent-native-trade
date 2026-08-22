/**
 * agent-trade/0.2 signed envelope types (specification.md §1).
 */

export type ObjectType = 'LISTING_REF' | 'DEAL' | 'TRADE_EVENT' | 'TRADE_RECEIPT';

export interface Signature {
  signer: string;
  algorithm: 'Ed25519';
  /** base64url (86 chars): raw 64-byte Ed25519 signature */
  signature: string;
  /** RFC 3339 / ISO 8601 UTC */
  issued_at: string;
}

export interface SignedFile {
  protocol: string;
  object_type: ObjectType;
  body: unknown;
  /** "sha256:" + lowerhex(SHA-256(utf8(JCS(body)))) */
  body_hash: string;
  signatures: Signature[];
}

export type VerifyResult =
  | 'valid'
  | 'fail:body_hash_mismatch'
  | 'fail:object_id_mismatch'
  | 'fail:schema_invalid'
  | 'fail:unknown_signer'
  | 'fail:signature_invalid'
  | 'fail:protocol_version';

/** Version policy: exact match, no auto-migration (specification.md §1). */
export const PROTOCOL = 'agent-trade/0.2';
