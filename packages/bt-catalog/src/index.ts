/**
 * @agent-trade/bt-catalog — canonical manifest build/verify + WebTorrent
 * seed/download + deterministic local tracker (module M4).
 */

export { buildManifest, catalogHash, verifyCatalogFiles, comparePaths, validateManifestPath, assertCanonicalManifest, ManifestValidationError } from './manifest.js';
export type { Manifest, ManifestFile } from './manifest.js';
export { seed } from './seed.js';
export type { SeedOptions, SeedResult } from './seed.js';
export { download } from './download.js';
export type { DownloadOptions } from './download.js';
export { startTracker } from './tracker.js';
export type { TrackerHandle } from './tracker.js';
