/**
 * Canonical catalog manifest — specification.md §4 (LISTING_REF).
 *
 * Rules (normative, hard-coded here and covered by unit tests):
 *
 * 1. paths are UTF-8, forward-slash, relative; `..` segments, a leading `/`,
 *    backslashes and empty segments are rejected;
 * 2. `files` is sorted by **byte order** of the UTF-8 encoding of `path`
 *    (not by UTF-16 code units — the two disagree outside the BMP);
 * 3. duplicate paths are rejected;
 * 4. each `sha256` is lowercase hex without prefix;
 * 5. `catalogHash = "sha256:" + hex(JCS(manifest))` over the canonical manifest.
 */

import { jcs, sha256Hex } from '@agent-trade/identity';

/** Lowercase hex sha-256 digest (64 chars, no prefix). */
export interface ManifestFile {
  path: string;
  sha256: string;
}

export interface Manifest {
  files: ManifestFile[];
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Byte-order comparison of two paths (UTF-8 byte sequences). */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Validate a single manifest path against the canonical rules.
 * Throws {@link ManifestValidationError} on the first violation.
 */
export function validateManifestPath(p: string): void {
  if (typeof p !== 'string') {
    throw new ManifestValidationError('path must be a string');
  }
  if (p.length === 0) {
    throw new ManifestValidationError('path must not be empty');
  }
  if (p.includes('\\')) {
    throw new ManifestValidationError(`path must use forward slashes (no backslash): ${JSON.stringify(p)}`);
  }
  if (p.startsWith('/')) {
    throw new ManifestValidationError(`path must be relative (no leading slash): ${JSON.stringify(p)}`);
  }
  // The path must be representable as UTF-8: strings with lone surrogates do
  // not round-trip through UTF-8 encoding/decoding.
  if (Buffer.from(p, 'utf8').toString('utf8') !== p) {
    throw new ManifestValidationError(`path must be valid UTF-8: ${JSON.stringify(p)}`);
  }
  for (const segment of p.split('/')) {
    if (segment === '') {
      throw new ManifestValidationError(`path must not contain empty segments: ${JSON.stringify(p)}`);
    }
    if (segment === '..') {
      throw new ManifestValidationError(`path must not contain '..' segments: ${JSON.stringify(p)}`);
    }
  }
}

/**
 * Build the canonical manifest for the given files: computes lowercase-hex
 * sha-256 per file, validates paths, and sorts `files` by byte order of path.
 * Duplicate paths are rejected.
 */
export function buildManifest(files: { path: string; data: Uint8Array }[]): Manifest {
  if (!Array.isArray(files)) {
    throw new ManifestValidationError('files must be an array');
  }
  const entries: ManifestFile[] = files.map((file, i) => {
    if (file === null || typeof file !== 'object') {
      throw new ManifestValidationError(`files[${i}] must be an object { path, data }`);
    }
    validateManifestPath(file.path);
    if (!(file.data instanceof Uint8Array)) {
      throw new ManifestValidationError(`files[${i}] data must be a Uint8Array (path: ${JSON.stringify(file.path)})`);
    }
    return { path: file.path, sha256: sha256Hex(file.data) };
  });

  entries.sort((a, b) => comparePaths(a.path, b.path));

  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.path === entries[i - 1]!.path) {
      throw new ManifestValidationError(`duplicate path: ${JSON.stringify(entries[i]!.path)}`);
    }
  }
  return { files: entries };
}

/**
 * Assert that `manifest` is canonical: valid unique paths, lowercase-hex
 * sha-256 digests, and `files` strictly sorted by byte order of path.
 * Throws {@link ManifestValidationError} otherwise.
 */
export function assertCanonicalManifest(manifest: Manifest): void {
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new ManifestValidationError('manifest must be an object { files: ManifestFile[] }');
  }
  const seen = new Set<string>();
  let prev: string | null = null;
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== 'object') {
      throw new ManifestValidationError('manifest.files entries must be objects { path, sha256 }');
    }
    validateManifestPath(entry.path);
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX_RE.test(entry.sha256)) {
      throw new ManifestValidationError(
        `sha256 must be 64 lowercase hex characters (no prefix) for path: ${JSON.stringify(entry.path)}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new ManifestValidationError(`duplicate path: ${JSON.stringify(entry.path)}`);
    }
    seen.add(entry.path);
    if (prev !== null && comparePaths(prev, entry.path) >= 0) {
      throw new ManifestValidationError(
        `files must be sorted by byte order of path; violation at: ${JSON.stringify(entry.path)}`,
      );
    }
    prev = entry.path;
  }
}

/**
 * `catalogHash` = `"sha256:" + hex(SHA-256(utf8(JCS(manifest))))` (spec §4).
 * The input must already be canonical (see {@link assertCanonicalManifest});
 * use {@link buildManifest} to produce one.
 */
export function catalogHash(manifest: Manifest): string {
  assertCanonicalManifest(manifest);
  return 'sha256:' + sha256Hex(jcs(manifest));
}

/**
 * Verify that the given files match every entry of `manifest`: every manifest
 * path must be present (exact path match) with an identical sha-256 digest.
 * Extra files that are not listed in the manifest are ignored. Returns `false`
 * for any mismatch, missing file, duplicate input path, or non-canonical
 * manifest (instead of throwing).
 */
export function verifyCatalogFiles(files: { path: string; data: Uint8Array }[], manifest: Manifest): boolean {
  if (!Array.isArray(files) || manifest === null || typeof manifest !== 'object') {
    return false;
  }
  try {
    assertCanonicalManifest(manifest);
  } catch {
    return false;
  }
  const byPath = new Map<string, Uint8Array>();
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string') {
      return false;
    }
    if (!(file.data instanceof Uint8Array)) {
      return false;
    }
    if (byPath.has(file.path)) {
      return false; // ambiguous input
    }
    byPath.set(file.path, file.data);
  }
  for (const entry of manifest.files) {
    const data = byPath.get(entry.path);
    if (data === undefined) {
      return false; // manifest file missing from the delivered set
    }
    if (sha256Hex(data) !== entry.sha256) {
      return false; // content mismatch (tamper / corruption)
    }
  }
  return true;
}
