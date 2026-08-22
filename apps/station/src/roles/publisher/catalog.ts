/**
 * @agent-trade/station — catalog directory reading (module S3).
 *
 * The publisher reads the catalog directory into canonical-manifest entries
 * whose `path` is prefixed with the directory basename, exactly matching the
 * file paths WebTorrent carries when `seed(catalog_dir)` runs (see the M4
 * round-trip: seeding `<parent>/catalog-a` yields torrent paths `catalog-a/…`).
 * This keeps `catalog_hash` byte-consistent between "manifest built from disk"
 * and "manifest rebuilt from a download".
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { buildManifest } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';

import type { CatalogArchive, CatalogMetadata } from './types.js';

export interface CatalogEntry {
  /** manifest / torrent path (basename-prefixed, forward slash) */
  path: string;
  /** path relative to the catalog directory root (forward slash) */
  relPath: string;
  /** absolute path on disk */
  absPath: string;
  data: Uint8Array;
}

/** Recursively read a catalog directory. Skips symlinks and special files. */
export async function readCatalogDir(dir: string): Promise<CatalogEntry[]> {
  const root = resolve(dir);
  const prefix = basename(root);
  const out: CatalogEntry[] = [];

  async function walk(absDir: string, rel: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const buf = await readFile(abs);
        out.push({ path: `${prefix}/${relPath}`, relPath, absPath: abs, data: new Uint8Array(buf) });
      }
      // symlinks and special files are not part of the catalog
    }
  }

  await walk(root, '');
  return out;
}

export function buildCatalogManifest(entries: CatalogEntry[]): Manifest {
  return buildManifest(entries.map((entry) => ({ path: entry.path, data: entry.data })));
}

/** `{ manifest, files: [{ path, content(base64) }] }` — M8-compatible archive. */
export function buildCatalogArchive(entries: CatalogEntry[], manifest: Manifest): CatalogArchive {
  return {
    manifest,
    files: entries.map((entry) => ({
      path: entry.path,
      content: Buffer.from(entry.data).toString('base64'),
    })),
  };
}

/**
 * Parse `catalog.json` at the catalog root for `catalog_id`, `item_id`,
 * `item_revision` (default 0) and `metadata.tags`. Tags are read for logging
 * only — the LISTING_REF body schema is `additionalProperties: false`, so they
 * are not (and must not be) echoed into it; the indexer reads them from the
 * mirrored catalog content.
 */
export function parseCatalogMetadata(entries: CatalogEntry[]): CatalogMetadata {
  const entry = entries.find((e) => e.relPath === 'catalog.json');
  if (entry === undefined) {
    throw new Error('publisher.catalog_dir: missing catalog.json at the directory root');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(entry.data));
  } catch (err) {
    throw new Error(`catalog.json: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('catalog.json: expected a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const catalogId = obj['catalog_id'];
  if (typeof catalogId !== 'string' || catalogId.length === 0) {
    throw new Error('catalog.json: catalog_id must be a non-empty string');
  }
  const itemId = obj['item_id'];
  if (typeof itemId !== 'string' || itemId.length === 0) {
    throw new Error('catalog.json: item_id must be a non-empty string');
  }

  let itemRevision = 0;
  if (obj['item_revision'] !== undefined) {
    const revision = obj['item_revision'];
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new Error('catalog.json: item_revision must be an integer >= 0');
    }
    itemRevision = revision;
  }

  let tags: string[] = [];
  if (obj['metadata'] !== undefined) {
    const metadata = obj['metadata'];
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error('catalog.json: metadata must be an object');
    }
    const rawTags = (metadata as Record<string, unknown>)['tags'];
    if (rawTags !== undefined) {
      if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string')) {
        throw new Error('catalog.json: metadata.tags must be an array of strings');
      }
      tags = rawTags as string[];
    }
  }

  return { catalog_id: catalogId, item_id: itemId, item_revision: itemRevision, tags };
}
