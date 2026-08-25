import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../src/sanitize.js';

describe('sanitizeFilename', () => {
  it('keeps a plain filename', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips POSIX traversal segments', () => {
    expect(sanitizeFilename('../../evil.sh')).toBe('evil.sh');
    expect(sanitizeFilename('a/b/../c.txt')).toBe('c.txt');
    expect(sanitizeFilename('../../../../etc/passwd')).toBe('passwd');
  });

  it('rejects absolute paths down to the basename', () => {
    expect(sanitizeFilename('/etc/cron.d/evil')).toBe('evil');
    expect(sanitizeFilename('///var//log//x.log')).toBe('x.log');
  });

  it('strips Windows backslash traversal', () => {
    expect(sanitizeFilename('..\\..\\win.exe')).toBe('win.exe');
    expect(sanitizeFilename('C:\\Windows\\System32\\x.dll')).toBe('x.dll');
  });

  it('strips Windows drive prefixes without a separator', () => {
    expect(sanitizeFilename('C:foo.txt')).toBe('foo.txt');
    expect(sanitizeFilename('c:evil')).toBe('evil');
  });

  it('returns the last segment of nested paths', () => {
    expect(sanitizeFilename('dir1/dir2/file.txt')).toBe('file.txt');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('..')).toBe('attachment');
    expect(sanitizeFilename('.')).toBe('attachment');
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('/')).toBe('attachment');
    expect(sanitizeFilename('\\')).toBe('attachment');
    expect(sanitizeFilename('...')).toBe('...');
  });

  it('strips control characters and NUL', () => {
    expect(sanitizeFilename('evil\u0000.sh')).toBe('evil.sh');
    expect(sanitizeFilename('a\tb\nc.txt')).toBe('abc.txt');
  });

  it('never returns a path separator or traversal segment', () => {
    for (const name of ['../../x', '/x', 'a\\..\\x', '..\\..', 'a/b/..']) {
      const out = sanitizeFilename(name);
      expect(out).not.toMatch(/[/\\]/);
      expect(out).not.toBe('..');
    }
  });

  it('throws for non-string input', () => {
    expect(() => sanitizeFilename(42 as unknown as string)).toThrow(/must be a string/);
  });

  it('truncates over-long names to a bounded byte length, keeping a short extension', () => {
    const out = sanitizeFilename(`${'x'.repeat(300)}.bin`);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(96);
    expect(out.endsWith('.bin')).toBe(true);
    expect(out.length).toBeGreaterThan(4);
  });

  it('truncates multibyte names without splitting a code point', () => {
    const out = sanitizeFilename('螺'.repeat(200)); // 600 UTF-8 bytes
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(96);
    // a valid string round-trips: no partial sequence was left behind
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    expect([...out].every((ch) => ch === '螺')).toBe(true);
  });

  it('truncates names with no extension too', () => {
    const out = sanitizeFilename('a'.repeat(500));
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(96);
  });
});
