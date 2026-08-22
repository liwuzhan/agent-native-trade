import { describe, expect, it } from 'vitest';

import { jcs, publicKeyFromSeed, sha256Hex, verify } from '../src/index.js';

import { loadVectors, signingInput } from './helpers.js';

const vectors = loadVectors();

describe('M1 acceptance 1: strict verify against test vectors', () => {
  const validCases = vectors.cases.filter((c) => c.expect === 'valid');
  const rehashCase = vectors.cases.find((c) => c.name === 'deal-tampered-body-rehash');

  it('accepts every signature in every expect=valid case', () => {
    expect(validCases.length).toBeGreaterThan(0);
    for (const c of validCases) {
      const input = signingInput(c.file.protocol, c.file.object_type, c.file.body_hash);
      for (const s of c.file.signatures) {
        const pub = vectors.identities[s.signer]!.public_key;
        expect(verify(input, s.signature, pub), `${c.name} signer=${s.signer}`).toBe(true);
      }
    }
  });

  it('rejects deal-tampered-body-rehash (signatures were made over the old body_hash)', () => {
    expect(rehashCase).toBeDefined();
    const c = rehashCase!;
    const input = signingInput(c.file.protocol, c.file.object_type, c.file.body_hash);
    for (const s of c.file.signatures) {
      expect(verify(input, s.signature, vectors.identities[s.signer]!.public_key)).toBe(false);
    }
  });

  it('rejects signatures under a wrong public key', () => {
    const c = vectors.cases.find((x) => x.name === 'listing-ref-valid')!;
    const input = signingInput(c.file.protocol, c.file.object_type, c.file.body_hash);
    const wrongPub = vectors.identities['agent_buyer']!.public_key;
    for (const s of c.file.signatures) {
      expect(verify(input, s.signature, wrongPub)).toBe(false);
    }
  });
});

describe('M1 acceptance 2: jcs + sha256Hex reproduces declared body_hash', () => {
  for (const c of vectors.cases) {
    const actual = 'sha256:' + sha256Hex(jcs(c.file.body));
    if (c.expect === 'fail:body_hash_mismatch') {
      it(`${c.name}: declared body_hash is stale and MUST NOT match (tamper kept old hash)`, () => {
        expect(actual).not.toBe(c.file.body_hash);
      });
    } else {
      it(`${c.name}: "sha256:" + sha256Hex(jcs(body)) === body_hash`, () => {
        expect(actual).toBe(c.file.body_hash);
      });
    }
  }
});

describe('M1 extras: object_id and seed-derived public keys cross-check the reference generator', () => {
  it('recomputes the declared object_id (sha256 of signing_input) for every case that declares one', () => {
    for (const c of vectors.cases) {
      if (!c.object_id) continue;
      const input = signingInput(c.file.protocol, c.file.object_type, c.file.body_hash);
      expect('sha256:' + sha256Hex(input), c.name).toBe(c.object_id);
    }
  });

  it('derives the declared public key from each test seed (noble ⇄ node:crypto parity)', () => {
    for (const [name, idt] of Object.entries(vectors.identities)) {
      expect(publicKeyFromSeed(idt.seed), name).toBe(idt.public_key);
    }
  });
});
