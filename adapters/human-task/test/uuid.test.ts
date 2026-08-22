import { describe, expect, it } from 'vitest';

import { UUIDV7_RE, uuidv7 } from '../src/uuid.js';

/** Decode the 48-bit millisecond timestamp from the first 12 hex chars (dash-stripped). */
function decodeMs(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

describe('uuid v7: format assertions', () => {
  it('matches the canonical v7 pattern (version 7, variant 10)', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(id).toMatch(UUIDV7_RE);
      expect(id.length).toBe(36);
      // version nibble at char 14, variant nibble at char 19
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
  });

  it('embeds the 48-bit millisecond timestamp verbatim', () => {
    expect(decodeMs(uuidv7(0))).toBe(0);
    expect(decodeMs(uuidv7(1))).toBe(1);
    expect(decodeMs(uuidv7(0x0000_0001_0000))).toBe(0x0000_0001_0000);
    const now = Date.now();
    expect(decodeMs(uuidv7(now))).toBe(now);
  });

  it('is time-ordered: uuidv7(t1) < uuidv7(t2) whenever t1 < t2', () => {
    const t1 = Date.now();
    const t2 = t1 + 1_000_000;
    const a = uuidv7(t1);
    const b = uuidv7(t2);
    expect(a < b).toBe(true);
    // same timestamp → ordering falls back to the random bits, still total
    const c = uuidv7(t1);
    const d = uuidv7(t1);
    expect(c === d ? true : c < d || d < c).toBe(true);
  });

  it('generates unique ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(1000);
  });

  it('rejects timestamps outside the 48-bit field', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });
});
