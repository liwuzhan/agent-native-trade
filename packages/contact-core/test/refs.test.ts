import { describe, expect, it } from 'vitest';
import { parseEmailContact, resolveEmailContacts } from '../src/index.js';

describe('contact references', () => {
  it('normalizes a portable mailto reference', () => {
    expect(parseEmailContact({ type: 'email', uri: 'mailto:seller@example.net' })).toEqual({
      type: 'email',
      uri: 'mailto:seller@example.net',
      address: 'seller@example.net',
      profile: 'agent-trade-email-v1',
      capabilities: [],
      priority: 0,
    });
  });

  it('sorts supported references by descending priority and keeps ties stable', () => {
    const refs = resolveEmailContacts([
      { type: 'email', uri: 'mailto:b@example.net', priority: 10 },
      { type: 'matrix', uri: 'matrix:u@example.net', priority: 999 },
      { type: 'email', uri: 'mailto:a@example.net', priority: 20 },
      { type: 'email', uri: 'mailto:c@example.net', priority: 10 },
    ]);
    expect(refs.map((ref) => ref.address)).toEqual([
      'a@example.net',
      'b@example.net',
      'c@example.net',
    ]);
  });

  it.each([
    'https://seller.example.net',
    'mailto:a@example.net?subject=hidden',
    'mailto:a@example.net,b@example.net',
    'mailto:not-an-address',
  ])('rejects non-minimal email contact %s', (uri) => {
    expect(() => parseEmailContact({ type: 'email', uri })).toThrow();
  });
});
