import { describe, expect, it } from 'vitest';
import { deriveFromAddress, parseMailUrl } from '../src/url.js';

describe('parseMailUrl', () => {
  it('parses smtp:// with explicit port and credentials', () => {
    const u = parseMailUrl('smtp://trader:secret@127.0.0.1:3025', 'smtp');
    expect(u).toEqual({
      protocol: 'smtp',
      host: '127.0.0.1',
      port: 3025,
      secure: false,
      user: 'trader',
      pass: 'secret',
    });
  });

  it('parses imap:// with explicit port', () => {
    const u = parseMailUrl('imap://trader:secret@127.0.0.1:3143', 'imap');
    expect(u.protocol).toBe('imap');
    expect(u.port).toBe(3143);
    expect(u.secure).toBe(false);
  });

  it('applies default ports per scheme', () => {
    expect(parseMailUrl('smtp://h', 'smtp').port).toBe(587);
    expect(parseMailUrl('smtps://h', 'smtp').port).toBe(465);
    expect(parseMailUrl('smtps://h', 'smtp').secure).toBe(true);
    expect(parseMailUrl('imap://h', 'imap').port).toBe(143);
    expect(parseMailUrl('imaps://h', 'imap').port).toBe(993);
    expect(parseMailUrl('imaps://h', 'imap').secure).toBe(true);
  });

  it('decodes URL-encoded credentials', () => {
    const u = parseMailUrl('smtp://user%40example.com:p%40ss@host:25', 'smtp');
    expect(u.user).toBe('user@example.com');
    expect(u.pass).toBe('p@ss');
  });

  it('handles missing credentials', () => {
    const u = parseMailUrl('smtp://mail.example.com', 'smtp');
    expect(u.user).toBeUndefined();
    expect(u.pass).toBeUndefined();
  });

  it('rejects a URL of the wrong kind', () => {
    expect(() => parseMailUrl('smtp://h', 'imap')).toThrow(/expected a imap:\/\/ URL/);
    expect(() => parseMailUrl('imap://h', 'smtp')).toThrow(/expected a smtp:\/\/ URL/);
  });

  it('rejects unsupported protocols', () => {
    expect(() => parseMailUrl('http://h', 'smtp')).toThrow(/unsupported mail URL protocol/);
  });

  it('rejects malformed URLs and missing hosts', () => {
    expect(() => parseMailUrl('not a url', 'smtp')).toThrow(/invalid mail URL/);
    expect(() => parseMailUrl('smtp://', 'smtp')).toThrow(/missing host/);
  });
});

describe('deriveFromAddress', () => {
  it('uses user@host when the user has no domain', () => {
    expect(deriveFromAddress('smtp://trader:secret@127.0.0.1:3025')).toBe('trader@127.0.0.1');
  });

  it('keeps a full-email user as-is', () => {
    expect(deriveFromAddress('smtp://trader%40example.com:secret@host:25')).toBe('trader@example.com');
  });

  it('falls back to agent@host without a user', () => {
    expect(deriveFromAddress('smtp://mail.example.com:25')).toBe('agent@mail.example.com');
  });
});
