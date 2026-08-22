import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { jcs, sha256Hex } from '../src/index.js';

/**
 * M1 acceptance 3: cross-check our RFC 8785 `jcs` against the reference npm
 * package `canonicalize` on ≥50 samples. Sample coverage requirements from the
 * module card: deep nesting, Chinese/emoji, shuffled key order, integers, `0`,
 * negatives, true/false/null, empty objects/arrays, strings containing control
 * characters and quotes.
 */
describe('M1 acceptance 3: JCS cross-check vs canonicalize (RFC 8785)', () => {
  const samples: unknown[] = [
    // booleans + null
    null,
    true,
    false,
    // integers
    0,
    -0,
    1,
    -1,
    7,
    42,
    -17,
    1000000,
    -1000000,
    9007199254740991, // 2^53 - 1
    // floats (Number::toString edge cases)
    0.5,
    -2.5,
    3.141592653589793,
    1e21,
    1e-7,
    5e-324, // Number.MIN_VALUE
    1.7976931348623157e308, // Number.MAX_VALUE
    // strings: empty, quotes, backslashes, control chars, unicode, emoji
    '',
    'a',
    'a"b',
    'a\\b',
    'quote " inside',
    'back\\slash',
    'line\nbreak',
    'tab\there',
    '\u0000',
    'ctrl\u0001\u001fchars',
    '中文字符串测试',
    'emoji 🚀🎉😀',
    'mixed 中文 "quoted" \n end',
    'no-break\u00a0space',
    'café ☕',
    // arrays: empty, nested, mixed
    [],
    [1, 2, 3],
    ['a', 'b'],
    [null, true, false, 0],
    [[1, [2, [3, [4]]]]],
    [{}, []],
    [1, [2], { a: 3 }],
    // objects: empty, single, shuffled key order, deep nesting, unicode keys
    {},
    { a: 1 },
    { b: 1, a: 2 },
    { z: 1, a: 2, m: 3 },
    { a: 1, b: 2, c: 3 },
    { c: 3, a: 1, b: 2 }, // same content, different insertion order
    { 中: 1, a: 2, '🚀': 3 },
    { '': 1, ' ': 2, a: 3 },
    { 'key"quote': 1, 'key\\slash': 2, 'key\u0001ctrl': 3, plain: 4 },
    { a: { b: { c: { d: { e: { f: [1, { g: 2 }] } } } } } },
    { arr: [{}, [], { a: [] }, { b: {} }], n: null, t: true, f: false, zero: 0, neg: -1, i: 42, s: 'x', f2: 1.5 },
    { '😀': 'a', 中: 'b', z: 'c', A: 'd', a: 'e', 0: 'zero', _: 'us' },
    { unicode: '中文 🚀 测试', nested: { deep: { deeper: { deepest: [1, null, 'emoji🎉'] } } } },
    { nums: [0, -0, 1, -1, 1e21, 5e-324, 9007199254740991], strs: ['', 'x', 'y'] },
    { k1: { k2: { k3: [{ k4: null }, [], {}, true] } } },
    // shuffled-key pairs of the same logical object (order-independence)
    { alpha: 1, beta: { gamma: [1, 2], delta: null }, omega: 'end' },
    { omega: 'end', beta: { delta: null, gamma: [1, 2] }, alpha: 1 },
  ];

  it(`produces identical output on ${samples.length} samples`, () => {
    expect(samples.length).toBeGreaterThanOrEqual(50);
    for (let i = 0; i < samples.length; i++) {
      const ref = canonicalize(samples[i]);
      expect(ref, `sample #${i} must be canonicalizable by the reference`).toBeTypeOf('string');
      const label = JSON.stringify(samples[i])?.slice(0, 80) ?? String(samples[i]);
      expect(jcs(samples[i]), `sample #${i}: ${label}`).toBe(ref);
    }
  });

  it('sorts object keys by UTF-16 code units (astral first code unit > BMP letters)', () => {
    // U+1F600 = '\uD83D\uDE00' → first code unit 0xD83D sorts after 'a' (0x61)
    const ref = canonicalize({ a: 1, '😀': 2 });
    expect(jcs({ '😀': 2, a: 1 })).toBe(ref);
    expect(jcs({ a: 1, '😀': 2 })).toBe('{"a":1,"😀":2}');
  });

  it('rejects non-finite numbers and non-JSON types', () => {
    expect(() => jcs(NaN)).toThrow();
    expect(() => jcs(Infinity)).toThrow();
    expect(() => jcs(-Infinity)).toThrow();
    expect(() => jcs(undefined)).toThrow();
    expect(() => jcs(1n as unknown)).toThrow(); // bigint
    expect(() => jcs(() => undefined)).toThrow(); // function
    expect(() => jcs(Symbol('x') as unknown)).toThrow(); // symbol
  });
});

describe('sha256Hex (M1 primitive) sanity', () => {
  it('matches well-known SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('中文测试')).toMatch(/^[0-9a-f]{64}$/);
  });
});
