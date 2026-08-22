import { describe, expect, it } from 'vitest';

import { verify } from '@agent-trade/identity';

import { addSignature, buildObject, objectId, verifyFile } from '../src/index.js';
import { validateStructure } from '../src/schema.js';
import { signingInputBytes } from '../src/sign.js';
import type { SignedFile, VerifyResult } from '../src/types.js';
import { loadVectors, resolveKeyFor } from './helpers.js';

const vectors = loadVectors();
const resolveKey = resolveKeyFor(vectors.identities);
const caseByName = (name: string) => vectors.cases.find((c) => c.name === name)!;

/**
 * A deliberately weakened verifier for the regression test (M2 acceptance 3):
 * the exact verifyFile pipeline with step ① (body_hash recomputation) removed.
 * If verifyFile ever regresses to "skip ①", it behaves exactly like this and
 * accepts the keep-hash attack — the contrast test below proves ① is
 * load-bearing.
 */
function naiveVerify(file: SignedFile, resolveKeyFn: (signer: string) => string | undefined): VerifyResult {
  if (file.protocol !== 'agent-trade/0.2') return 'fail:protocol_version';
  // ② recompute object_id — vector files carry no declaration, so no compare
  void objectId(file);
  // ③ schema
  if (!validateStructure(file)) return 'fail:schema_invalid';
  // ④ signatures over the *declared* body_hash
  const input = signingInputBytes(file);
  for (const s of file.signatures) {
    const publicKey = resolveKeyFn(s.signer);
    if (typeof publicKey !== 'string' || publicKey.length === 0) return 'fail:unknown_signer';
    let ok = false;
    try {
      ok = verify(input, s.signature, publicKey);
    } catch {
      ok = false;
    }
    if (!ok) return 'fail:signature_invalid';
  }
  return 'valid';
}

describe('M2 acceptance 2: multi-signature independence', () => {
  const deal = caseByName('deal-valid');

  it('removing either signature keeps the remaining one valid', () => {
    const [buyerSig, sellerSig] = deal.file.signatures;
    expect(verifyFile({ ...deal.file, signatures: [buyerSig] }, resolveKey)).toBe('valid');
    expect(verifyFile({ ...deal.file, signatures: [sellerSig] }, resolveKey)).toBe('valid');
  });

  it('appending a signature does not break existing ones (后签不破先签)', () => {
    // rebuild deterministically via the public API (no RNG: explicit issued_at)
    const base = buildObject('DEAL', structuredClone(deal.file.body));
    const one = addSignature(base, 'agent_buyer', vectors.identities.agent_buyer.seed, '2026-08-22T03:00:00Z');
    const two = addSignature(one, 'agent_seller', vectors.identities.agent_seller.seed, '2026-08-22T03:05:00Z');

    expect(verifyFile(base, resolveKey)).toBe('fail:schema_invalid'); // unsigned → not structurally valid
    expect(verifyFile(one, resolveKey)).toBe('valid');
    expect(verifyFile(two, resolveKey)).toBe('valid');

    // the appended seller signature is genuine over the same signing input
    expect(
      verify(signingInputBytes(two), two.signatures[1].signature, vectors.identities.agent_seller.public_key),
    ).toBe(true);
  });
});

describe('M2 acceptance 3: step ① is load-bearing (naive verifier contrast)', () => {
  const tampered = caseByName('deal-tampered-body-keep-hash').file;

  it('naiveVerify (skipping ①) ACCEPTS deal-tampered-body-keep-hash', () => {
    // body changed, body_hash + signatures kept — schema still passes and the
    // signatures still verify over the declared body_hash, so a verifier that
    // skips ① is fooled.
    expect(naiveVerify(tampered, resolveKey)).toBe('valid');
  });

  it('verifyFile REJECTS it with fail:body_hash_mismatch', () => {
    expect(verifyFile(tampered, resolveKey)).toBe('fail:body_hash_mismatch');
  });
});

describe('M2 acceptance 4: schema rejection (genuine signature, fake structure)', () => {
  it('re-signed body without settlement fails with fail:schema_invalid', () => {
    const deal = caseByName('deal-valid');
    const body = structuredClone(deal.file.body) as Record<string, unknown>;
    delete body.settlement;

    // self-sign within the test (vectors seeds) over a fresh body_hash
    const forged = addSignature(buildObject('DEAL', body), 'agent_buyer', vectors.identities.agent_buyer.seed, '2026-08-22T03:00:00Z');

    // guard: the signature is cryptographically genuine — the rejection below
    // can only come from the schema step (①-② pass, ④ would pass).
    expect(verify(signingInputBytes(forged), forged.signatures[0].signature, vectors.identities.agent_buyer.public_key)).toBe(true);

    expect(verifyFile(forged, resolveKey)).toBe('fail:schema_invalid');
  });
});

describe('M2 acceptance 5: cross-type replay protection (type prefix in signing input)', () => {
  it('a LISTING_REF signature pasted verbatim onto a DEAL fails at the signature step', () => {
    const listing = caseByName('listing-ref-valid').file;
    const deal = caseByName('deal-valid').file;

    // DEAL envelope with deal-valid's body/body_hash, but the listing's signature
    const replay: SignedFile = { ...deal, signatures: [listing.signatures[0]] };

    // ①-③ pass (body is a genuine, schema-valid DEAL body with matching hash)
    expect(validateStructure(replay)).toBe(true);
    // ④ the signature was made over signing_input with object_type=LISTING_REF
    // and the listing's body_hash; here the type prefix differs → reject
    expect(verifyFile(replay, resolveKey)).toBe('fail:signature_invalid');
  });
});

describe('M2 edge cases', () => {
  const deal = caseByName('deal-valid').file;

  it('wrong protocol version → fail:protocol_version (no auto-migration)', () => {
    expect(verifyFile({ ...deal, protocol: 'agent-trade/0.1' }, resolveKey)).toBe('fail:protocol_version');
  });

  it('unresolvable signer → fail:unknown_signer', () => {
    const unknown = { ...deal, signatures: [{ ...deal.signatures[0], signer: 'mallory' }] };
    expect(verifyFile(unknown, resolveKey)).toBe('fail:unknown_signer');
  });

  it('declared object_id mismatch → fail:object_id_mismatch', () => {
    const withDeclared = { ...deal, object_id: 'sha256:' + '0'.repeat(64) } as SignedFile & { object_id: string };
    expect(verifyFile(withDeclared, resolveKey)).toBe('fail:object_id_mismatch');
  });

  it('empty signatures array → fail:schema_invalid (envelope schema requires ≥1)', () => {
    expect(verifyFile({ ...deal, signatures: [] }, resolveKey)).toBe('fail:schema_invalid');
  });

  it('tampered body with recomputed hash → fail:signature_invalid', () => {
    // vector case covered in acceptance 1; here the same attack via the API:
    // change the body, recompute body_hash, keep the ORIGINAL signature
    const body = structuredClone(deal.body) as Record<string, unknown>;
    (body.subject as Record<string, unknown>).description = 'M8×40 316不锈钢螺栓';
    const rehashed = buildObject('DEAL', body);
    const staleSig = { ...rehashed, signatures: [{ ...deal.signatures[0], signature: deal.signatures[0].signature }] };
    expect(verifyFile(staleSig, resolveKey)).toBe('fail:signature_invalid');
  });
});
