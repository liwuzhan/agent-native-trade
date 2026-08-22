/**
 * Attachment filename sanitization: strip path separators, traversal segments
 * and control characters so a hostile filename can never escape `inboxDir`.
 */

/** Fallback name when sanitization leaves nothing usable. */
const FALLBACK = 'attachment';

/**
 * Reduce an untrusted attachment filename to a single safe basename.
 *
 * - backslashes are treated as path separators (Windows-style traversal)
 * - `/`, `.` and `..` segments are dropped (the last non-empty segment wins)
 * - a Windows drive prefix (`C:foo`) is stripped
 * - NUL / control characters are removed
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
  if (base === '' || base === '.' || base === '..' || base === '~') {
    return FALLBACK;
  }
  return base;
}
