/**
 * Attachment filename sanitization: strip path separators, traversal segments
 * and control characters so a hostile filename can never escape `inboxDir`.
 */

/** Fallback name when sanitization leaves nothing usable. */
const FALLBACK = 'attachment';

/**
 * Hard cap on the sanitized filename length, in UTF-8 bytes. Filesystems
 * commonly reject names over 255 bytes (ENAMETOOLONG would abort the poll
 * loop); 96 leaves headroom for the caller's collision `-1`/`-2` suffixes.
 */
const MAX_FILENAME_BYTES = 96;

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point,
 * preserving a short extension when one is present.
 */
function truncateBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  const stem = ext === '' ? name : name.slice(0, dot);
  const budget = maxBytes - Buffer.byteLength(ext, 'utf8');
  let out = '';
  for (const ch of stem) {
    if (Buffer.byteLength(out + ch, 'utf8') > budget) break;
    out += ch;
  }
  return out + ext;
}

/**
 * Reduce an untrusted attachment filename to a single safe basename.
 *
 * - backslashes are treated as path separators (Windows-style traversal)
 * - `/`, `.` and `..` segments are dropped (the last non-empty segment wins)
 * - a Windows drive prefix (`C:foo`) is stripped
 * - NUL / control characters are removed
 * - the result is truncated to at most MAX_FILENAME_BYTES bytes (keeping a
 *   short extension) so a hostile name cannot trigger ENAMETOOLONG
 *
 * The result never contains `/`, `\` or `..`, so joining it with `inboxDir`
 * cannot escape the directory (a resolved-path containment check is still
 * performed as defense in depth by the caller).
 */
export function sanitizeFilename(name: string): string {
  if (typeof name !== 'string') {
    throw new TypeError(`attachment filename must be a string, got ${typeof name}`);
  }
  const withoutControl = name.replace(/[\u0000-\u001f\u007f]/g, '');
  const segments = withoutControl
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
  let base = segments.pop() ?? '';
  base = base.replace(/^[A-Za-z]:/, '');
  base = truncateBytes(base, MAX_FILENAME_BYTES);
  if (base === '' || base === '.' || base === '..' || base === '~') {
    return FALLBACK;
  }
  return base;
}
