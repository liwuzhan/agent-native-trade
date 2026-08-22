import { describe, expect, it } from 'vitest';
import { parseRaw } from '../src/parse.js';
import { buildRawMessage } from './helpers/raw.js';

describe('parseRaw', () => {
  it('maps headers, text and attachments onto ParsedMail', async () => {
    const raw = buildRawMessage({
      from: 'alice@example.com',
      to: 'bob@example.com',
      subject: 'deal offer',
      messageId: '<m-1@example.com>',
      inReplyTo: '<m-0@example.com>',
      tradeId: 'T-42',
      text: 'here is the deal',
      attachments: [{ filename: 'deal.signed', content: Buffer.from('SIGNED') }],
    });
    const parsed = await parseRaw(raw);
    expect(parsed.tradeId).toBe('T-42');
    expect(parsed.from).toBe('alice@example.com');
    expect(parsed.messageId).toBe('<m-1@example.com>');
    expect(parsed.inReplyTo).toBe('<m-0@example.com>');
    expect(parsed.text).toContain('here is the deal');
    expect(parsed.attachments).toEqual([
      { filename: 'deal.signed', content: Buffer.from('SIGNED') },
    ]);
  });

  it('returns empty tradeId when the header is missing', async () => {
    const raw = buildRawMessage({ from: 'a@b.c', subject: 'no trade' });
    const parsed = await parseRaw(raw);
    expect(parsed.tradeId).toBe('');
    expect(parsed.from).toBe('a@b.c');
    expect(parsed.messageId).toBe('');
  });

  it('skips inline cid attachments, keeps disposition attachments', async () => {
    const raw = buildRawMessage({
      messageId: '<m@x>',
      text: 'body',
      attachments: [
        { filename: 'file.bin', content: Buffer.from('F') },
        { filename: 'pic.png', disposition: 'inline', content: Buffer.from('P') },
      ],
    });
    const parsed = await parseRaw(raw);
    expect(parsed.attachments).toEqual([{ filename: 'file.bin', content: Buffer.from('F') }]);
  });

  it('handles binary attachment payloads with non-ascii bytes', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252, 255, 128]);
    const raw = buildRawMessage({ messageId: '<m@x>', attachments: [{ filename: 'b.bin', content: payload }] });
    const parsed = await parseRaw(raw);
    expect(parsed.attachments[0].content.equals(payload)).toBe(true);
  });

  it('yields empty text for attachment-only messages', async () => {
    const raw = buildRawMessage({ messageId: '<m@x>', attachments: [{ filename: 'b.bin', content: Buffer.from('X') }] });
    const parsed = await parseRaw(raw);
    expect(parsed.text).toBe('');
    expect(parsed.attachments).toHaveLength(1);
  });
});
