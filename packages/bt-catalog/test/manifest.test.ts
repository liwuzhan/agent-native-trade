/**
 * Acceptance #1 — canonical manifest rules (specification.md §4):
 * deterministic catalogHash regardless of add order, byte-order sorting,
 * rejection of illegal paths, duplicate detection, lowercase hex digests.
 */

import { describe, expect, it } from 'vitest';
import { jcs, sha256Hex } from '@agent-trade/identity';
import {
  assertCanonicalManifest,
  buildManifest,
  catalogHash,
  comparePaths,
  ManifestValidationError,
  validateManifestPath,
  verifyCatalogFiles,
} from '../src/manifest.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (n: number[]): Uint8Array => new Uint8Array(n);

describe('buildManifest — canonical rules', () => {
  it('same content in different add order → identical manifest and catalogHash', () => {
    const files = [
      { path: 'z.txt', data: utf8('z') },
      { path: 'a/b.json', data: utf8('{"x":1}') },
      { path: 'm.bin', data: bytes([0, 1, 2, 255]) },
      { path: 'sub/empty', data: bytes([]) },
    ];
    const shuffled = [files[3]!, files[1]!, files[0]!, files[2]!];
    const m1 = buildManifest(files);
    const m2 = buildManifest(shuffled);
    expect(m1).toEqual(m2);
    expect(catalogHash(m1)).toBe(catalogHash(m2));
  });

  it('sorts by byte order: "a-b.json" (0x2D) before "a/b.json" (0x2F)', () => {
    const m = buildManifest([
      { path: 'a/b.json', data: utf8('x') },
      { path: 'a-b.json', data: utf8('y') },
    ]);
    expect(m.files.map((f) => f.path)).toEqual(['a-b.json', 'a/b.json']);
    expect(comparePaths('a-b.json', 'a/b.json')).toBeLessThan(0);
  });

  it('sorts by UTF-8 byte order, not UTF-16 code-unit order (non-BMP case)', () => {
    // '\uE000' → bytes EE 80 80; '\u{10000}' → bytes F0 90 80 80.
    // Byte order: EE < F0, so '\uE000' first — even though its UTF-16 code
    // unit (0xE000) sorts AFTER the surrogate pair of '\u{10000}' (0xD800).
    const m = buildManifest([
      { path: '\u{10000}/x', data: utf8('a') },
      { path: '\uE000/y', data: utf8('b') },
    ]);
    expect(m.files.map((f) => f.path)).toEqual(['\uE000/y', '\u{10000}/x']);
    // sanity check that String.prototype.sort would disagree:
    expect(['\u{10000}/x', '\uE000/y'].sort()).toEqual(['\u{10000}/x', '\uE000/y']);
  });

  it('sorts stable, nested dirs and longer paths in byte order', () => {
    const m = buildManifest([
      { path: 'a', data: utf8('1') },
      { path: 'a.b', data: utf8('2') },
      { path: 'a/b', data: utf8('3') },
      { path: 'A', data: utf8('4') },
    ]);
    // 'A' (0x41) < 'a' (0x61); "a" (prefix) < "a.b"; '.' (0x2E) < '/' (0x2F)
    expect(m.files.map((f) => f.path)).toEqual(['A', 'a', 'a.b', 'a/b']);
  });

  it('rejects every illegal path form', () => {
    const illegal = [
      '', // empty
      '..', // parent segment
      '../escape',
      'a/../b',
      '/abs', // leading slash
      '//double',
      'a\\b', // backslash
      'a\\b/c',
      'a//b', // empty segment
      'a/b/', // trailing empty segment
      '/leading/segment',
      '\uD800x', // lone surrogate — not valid UTF-8
    ];
    for (const p of illegal) {
      expect(() => buildManifest([{ path: p, data: utf8('x') }]), `path ${JSON.stringify(p)}`).toThrow(
        ManifestValidationError,
      );
      expect(() => validateManifestPath(p), `path ${JSON.stringify(p)}`).toThrow(ManifestValidationError);
    }
  });

  it('rejects non-string paths and non-Uint8Array data', () => {
    expect(() => buildManifest([{ path: 42 as unknown as string, data: utf8('x') }])).toThrow(ManifestValidationError);
    expect(() => buildManifest([{ path: 'a', data: 'not bytes' as unknown as Uint8Array }])).toThrow(
      ManifestValidationError,
    );
    expect(() => buildManifest(null as unknown as { path: string; data: Uint8Array }[])).toThrow(
      ManifestValidationError,
    );
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      buildManifest([
        { path: 'a.txt', data: utf8('one') },
        { path: 'a.txt', data: utf8('two') },
      ]),
    ).toThrow(/duplicate path/);
  });

  it('emits lowercase hex sha256 without prefix', () => {
    const m = buildManifest([{ path: 'a.txt', data: utf8('hello') }]);
    expect(m.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.files[0]!.sha256).toBe(sha256Hex(utf8('hello')));
    expect(m.files[0]!.sha256).not.toMatch(/[A-F]/);
  });
});

describe('catalogHash', () => {
  it('catalogHash = "sha256:" + hex(JCS(manifest))', () => {
    const m = buildManifest([
      { path: 'b', data: utf8('2') },
      { path: 'a', data: utf8('1') },
    ]);
    const expected = 'sha256:' + sha256Hex(jcs(m));
    expect(catalogHash(m)).toBe(expected);
    expect(catalogHash(m)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects non-canonical (unsorted / malformed) manifests', () => {
    const sorted = buildManifest([
      { path: 'a', data: utf8('1') },
      { path: 'b', data: utf8('2') },
    ]);
    const unsorted = { files: [sorted.files[1]!, sorted.files[0]!] };
    expect(() => catalogHash(unsorted)).toThrow(ManifestValidationError);
    expect(() => catalogHash({ files: [{ path: 'a', sha256: 'not-hex' }] })).toThrow(ManifestValidationError);
  });

  it('an empty catalog is canonical and hashes to the JCS of {"files":[]}', () => {
    expect(catalogHash({ files: [] })).toBe('sha256:' + sha256Hex('{"files":[]}'));
  });

  it('assertCanonicalManifest accepts the output of buildManifest', () => {
    const m = buildManifest([
      { path: 'a', data: utf8('1') },
      { path: 'b/c', data: utf8('2') },
    ]);
    expect(() => assertCanonicalManifest(m)).not.toThrow();
  });
});

describe('verifyCatalogFiles', () => {
  const manifest = buildManifest([
    { path: 'a.txt', data: utf8('hello') },
    { path: 'sub/b.bin', data: bytes([0, 1, 2, 255]) },
  ]);

  it('returns true when every manifest file matches', () => {
    expect(
      verifyCatalogFiles(
        [
          { path: 'sub/b.bin', data: bytes([0, 1, 2, 255]) },
          { path: 'a.txt', data: utf8('hello') },
        ],
        manifest,
      ),
    ).toBe(true);
  });

  it('returns false when a file content changed (corruption)', () => {
    expect(
      verifyCatalogFiles(
        [
          { path: 'a.txt', data: utf8('hell0') }, // one byte flipped
          { path: 'sub/b.bin', data: bytes([0, 1, 2, 255]) },
        ],
        manifest,
      ),
    ).toBe(false);
  });

  it('returns false when a manifest file is missing', () => {
    expect(verifyCatalogFiles([{ path: 'a.txt', data: utf8('hello') }], manifest)).toBe(false);
  });

  it('ignores extra files not listed in the manifest', () => {
    expect(
      verifyCatalogFiles(
        [
          { path: 'a.txt', data: utf8('hello') },
          { path: 'sub/b.bin', data: bytes([0, 1, 2, 255]) },
          { path: 'extra.txt', data: utf8('extra') },
        ],
        manifest,
      ),
    ).toBe(true);
  });

  it('returns false on duplicate input paths or non-canonical manifests', () => {
    expect(
      verifyCatalogFiles(
        [
          { path: 'a.txt', data: utf8('hello') },
          { path: 'a.txt', data: utf8('hello') },
        ],
        manifest,
      ),
    ).toBe(false);
    const unsorted = { files: [manifest.files[1]!, manifest.files[0]!] };
    expect(verifyCatalogFiles([], unsorted)).toBe(false);
    expect(verifyCatalogFiles([], { files: [] })).toBe(true); // empty catalog verifies
  });
});
