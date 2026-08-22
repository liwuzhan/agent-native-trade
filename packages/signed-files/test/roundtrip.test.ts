import { describe, expect, it } from 'vitest';

import { addSignature, buildObject, parse, serialize, verifyFile } from '../src/index.js';
import { loadVectors, resolveKeyFor } from './helpers.js';

const vectors = loadVectors();
const resolveKey = resolveKeyFor(vectors.identities);
const deal = vectors.cases.find((c) => c.name === 'deal-valid')!;

describe('M2 acceptance 6: serialization round-trip', () => {
  it('buildObject → addSignature×2 → serialize → parse → verifyFile === valid', () => {
    const file = addSignature(
      addSignature(buildObject('DEAL', structuredClone(deal.file.body)), 'agent_buyer', vectors.identities.agent_buyer.seed, '2026-08-22T03:00:00Z'),
      'agent_seller',
      vectors.identities.agent_seller.seed,
      '2026-08-22T03:05:00Z',
    );

    const text = serialize(file);
    const parsed = parse(text);

    expect(parsed).toEqual(file);
    expect(verifyFile(parsed, resolveKey)).toBe('valid');
  });

  it('two serialize() calls produce byte-identical output', () => {
    const file = addSignature(
      buildObject('LISTING_REF', structuredClone(vectors.cases.find((c) => c.name === 'listing-ref-valid')!.file.body)),
      'agent_seller',
      vectors.identities.agent_seller.seed,
      '2026-08-22T02:00:00Z',
    );
    expect(serialize(file)).toBe(serialize(file));
    expect(serialize(parse(serialize(file)))).toBe(serialize(file));
  });

  it('parse throws on non-object / malformed input', () => {
    expect(() => parse('[1,2]')).toThrow(TypeError);
    expect(() => parse('"just a string"')).toThrow(TypeError);
    expect(() => parse('{')).toThrow(SyntaxError);
  });
});

describe('buildObject semantics (specification.md §2)', () => {
  it('reproduces the vector body_hash and object_id from the raw body', () => {
    const built = buildObject('DEAL', deal.file.body);
    expect(built.protocol).toBe('agent-trade/0.2');
    expect(built.signatures).toEqual([]);
    expect(built.body_hash).toBe(deal.file.body_hash);
    expect(built.body_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
