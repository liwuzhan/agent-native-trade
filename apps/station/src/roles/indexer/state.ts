/**
 * @agent-trade/station — indexer role persisted state (module S2).
 *
 * The M8 kernel owns the receipt index (`.data/receipts.sqlite`) and the fact
 * store (`.data/objects/`). This file owns the *station* side of the indexer:
 * announced LISTING_REF references, compact catalog cards and extracted tags.
 * Full M8 archive mirroring is optional; search state stays small and survives
 * restarts in a single JSON file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CatalogCard } from '../../announcement.js';

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
  distribution_refs?: { type: string; uri: string }[];
  recorded_at: string;
}

export interface IndexerStateData {
  listingRefs: ListingRefRecord[];
  /** Tags per mirrored catalog_hash; `null` = catalog has no catalog.json/tags. */
  catalogTags: Record<string, string[] | null>;
  /** Compact, hash-verified metadata needed for search; never the full archive. */
  catalogCards: Record<string, CatalogCard>;
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
        const catalogCards =
          parsed.catalogCards !== null && typeof parsed.catalogCards === 'object'
            ? (parsed.catalogCards as Record<string, CatalogCard>)
            : {};
        return { listingRefs, catalogTags, catalogCards };
      } catch {
        return { listingRefs: [], catalogTags: {}, catalogCards: {} };
      }
    }
    return { listingRefs: [], catalogTags: {}, catalogCards: {} };
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

  setCatalogCard(catalogHash: string, card: CatalogCard, tags: string[] | null): void {
    this.data.catalogCards[catalogHash] = card;
    this.data.catalogTags[catalogHash] = tags;
    this.persist();
  }

  getCatalogCard(catalogHash: string): CatalogCard | undefined {
    return this.data.catalogCards[catalogHash];
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
