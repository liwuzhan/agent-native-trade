import { describe, expect, it } from 'vitest';

import { generateIdentity, publicKeyFromSeed, sign, verify } from '../src/index.js';
import { b64uDecode, b64uEncode } from '../src/base64url.js';

// Ed25519 group order (RFC 8032 §5): L = 2^252 + 27742317777372353535851937790883648493
const GROUP_ORDER_L = 2n ** 252n + 27742317777372353535851937790883648493n;

describe('M1 acceptance 4: sign→verify round-trip and stable seed derivation', () => {
  it('round-trips 100 random identities, rejecting tampered messages', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateIdentity();
      const msg = new TextEncoder().encode(`message-${i}`);
      const sig = sign(msg, id.secretKey);

      expect(sig).toHaveLength(86); // 64 raw bytes → 86 base64url chars
      expect(verify(msg, sig, id.publicKey)).toBe(true);
      expect(verify(new TextEncoder().encode(`message-${i}-tampered`), sig, id.publicKey)).toBe(false);
    }
  });

  it('publicKeyFromSeed is stable and matches the generated identity', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateIdentity();
      expect(id.publicKey).toHaveLength(43); // 32 raw bytes → 43 base64url chars
      expect(id.secretKey).toHaveLength(43);
      expect(publicKeyFromSeed(id.secretKey)).toBe(id.publicKey);
      // idempotent
      expect(publicKeyFromSeed(id.secretKey)).toBe(publicKeyFromSeed(id.secretKey));
    }
  });
});

describe('M1 acceptance 5: strict RFC 8032 rejects S+L malleation', () => {
  it('accepts a genuine signature but rejects the same signature with S+L', () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode('malleability check');
    const sig = sign(msg, id.secretKey);
    expect(verify(msg, sig, id.publicKey)).toBe(true);

    const raw = b64uDecode(sig);
    expect(raw).toHaveLength(64);

    // S is the little-endian last 32 bytes; for a valid signature S < L.
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(raw[32 + i]!);

    const sMalleated = s + GROUP_ORDER_L; // S+L ≥ L; since S < L and 2L < 2^256, no wrap
    const malleated = raw.slice();
    for (let i = 0; i < 32; i++) {
      malleated[32 + i] = Number((sMalleated >> BigInt(8 * i)) & 0xffn);
    }
    const malleatedSig = b64uEncode(malleated);

    expect(malleatedSig).not.toBe(sig); // the malleated S is genuinely different
    // ZIP-215 verification would accept this; strict RFC 8032 (zip215:false) must not.
    expect(verify(msg, malleatedSig, id.publicKey)).toBe(false);
  });
});
