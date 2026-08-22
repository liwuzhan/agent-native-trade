/**
 * @agent-trade/station — indexer role persisted state (module S2).
 *
 * The M8 kernel owns the receipt index (`.data/receipts.sqlite`) and the fact
 * store (`.data/objects/`). This file owns the *station* side of the indexer:
 * the announced LISTING_REF references and the tags extracted from mirrored
 * catalog archives. Both are re-derivable bookkeeping over the M8 mirror, kept
 * in a single JSON file so they survive restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ListingRefRecord {
  /** M2 object_id of the LISTING_REF envelope ("sha256:" + lowerhex(SHA-256(signing_input))). */
  object_id: string;
  /** Canonical (JCS) serialization of the full envelope — idempotency/conflict key. */
  content: string;
  publisher: string;
  catalog_id: string;
  catalog_hash: string;
  item_id: string;
  item_revision?: number;
  recorded_at: string;
}

export interface IndexerStateData {
  listingRefs: ListingRefRecord[];
  /** Tags per mirrored catalog_hash; `null` = catalog has no catalog.json/tags. */
  catalogTags: Record<string, string[] | null>;
}

export class IndexerState {
  private readonly file: string;
  private data: IndexerStateData;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'indexer-state.json');
    this.data = this.load();
  }

  private load(): IndexerStateData {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<IndexerStateData>;
        const listingRefs = Array.isArray(parsed.listingRefs)
          ? (parsed.listingRefs as ListingRefRecord[])
          : [];
        const catalogTags =
          parsed.catalogTags !== null && typeof parsed.catalogTags === 'object'
            ? (parsed.catalogTags as Record<string, string[] | null>)
            : {};
        return { listingRefs, catalogTags };
      } catch {
        return { listingRefs: [], catalogTags: {} };
      }
    }
    return { listingRefs: [], catalogTags: {} };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  findListingRef(objectId: string): ListingRefRecord | undefined {
    return this.data.listingRefs.find((r) => r.object_id === objectId);
  }

  addListingRef(record: ListingRefRecord): void {
    this.data.listingRefs.push(record);
    this.persist();
  }

  listingRefs(): readonly ListingRefRecord[] {
    return this.data.listingRefs;
  }

  setCatalogTags(catalogHash: string, tags: string[] | null): void {
    this.data.catalogTags[catalogHash] = tags;
    this.persist();
  }

  getCatalogTags(catalogHash: string): string[] | null | undefined {
    return this.data.catalogTags[catalogHash];
  }

  /** Number of mirrored catalogs (distinct catalog_hash present in the archive map). */
  catalogCount(): number {
    return Object.keys(this.data.catalogTags).length;
  }

  /** Mirrored catalogs that carry tags, for the yellow pages. */
  taggedCatalogs(): { catalog_hash: string; tags: string[] }[] {
    return Object.entries(this.data.catalogTags).flatMap(([catalog_hash, tags]) =>
      tags !== null && tags !== undefined && tags.length > 0 ? [{ catalog_hash, tags }] : [],
    );
  }
}
