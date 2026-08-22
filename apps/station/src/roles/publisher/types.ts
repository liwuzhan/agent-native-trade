/**
 * @agent-trade/station — publisher role types (module S3).
 */

import type { Manifest } from '@agent-trade/bt-catalog';
import type { SignedFile } from '@agent-trade/signed-files';

/**
 * `config.publisher` block. S1 passes the role block through verbatim; S3 owns
 * its schema. The card lists `catalog_dir`, `trackers[]`, `announce_to[]` and
 * `watch`; `dht`, `poll_interval_ms`, `announce_timeout_ms` and
 * `announce_retries` are optional extras (all have defaults) so tests can force
 * tracker-only / fast-fail behaviour.
 */
export interface PublisherConfig {
  catalog_dir: string;
  trackers: string[];
  announce_to: string[];
  watch: boolean;
  dht: boolean;
  poll_interval_ms: number;
  announce_timeout_ms: number;
  announce_retries: number;
}

/** Metadata extracted from `catalog.json` at the catalog directory root. */
export interface CatalogMetadata {
  catalog_id: string;
  item_id: string;
  item_revision: number;
  /**
   * Tags live in `catalog.json` `metadata.tags` (hash-protected by the
   * manifest), never in the LISTING_REF body (its schema is
   * `additionalProperties: false`). The publisher reads them for logging only;
   * the indexer reads them from the mirrored catalog content.
   */
  tags: string[];
}

/**
 * HTTP catalog archive served by `GET /catalogs/:hash`. Mirrors the M8
 * demo-indexer shape `{ manifest, files: [{ path, content(base64) }] }` so an
 * indexer mirror can store it byte-identically.
 */
export interface CatalogArchive {
  manifest: Manifest;
  files: { path: string; content: string }[];
}

/** Result of one publish (read → hash → seed → sign → store). */
export interface PublishResult {
  catalogHash: string;
  objectId: string;
  listingRef: SignedFile;
  magnetURI: string;
  torrentFile: Uint8Array;
  tags: string[];
  archive: CatalogArchive;
}

/** Outcome of announcing the current LISTING_REF to one indexer. */
export interface AnnounceResult {
  url: string;
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

/** Handle returned by the publisher role's `start()`. */
export interface PublisherHandle {
  stop(): Promise<void>;
  port: number;
  /** Re-run the publish pipeline (hash → seed → sign → store) without announcing. */
  publish(): Promise<PublishResult>;
  /** The currently published result, or null before the first publish. */
  current(): PublishResult | null;
}
