/**
 * @agent-trade/station — integrator role types (module S4).
 */

import type { Manifest } from '@agent-trade/bt-catalog';
import type { SignedFile } from '@agent-trade/signed-files';

/**
 * `config.integrator` block. S1 passes the role block through verbatim; S4 owns
 * its schema. The card lists `theme`, `tags[]`, `members[]` (LISTING_REF file
 * paths or http(s) URLs), `reseed` and an optional `refresh_interval_ms`.
 * `announce_to`, `trackers`, `dht`, `announce_timeout_ms` and `announce_retries`
 * are optional extras (all have defaults) so tests can force deterministic
 * announce / reseed behaviour — the card references `announce_to` in behaviour
 * item 4 even though it is not in the config key list.
 */
export interface IntegratorConfig {
  /** Topic catalog theme (used as the synthesized catalog's `item_id`). */
  theme: string;
  /**
   * Tags placed into the synthesized catalog's `metadata.tags` (hash-protected
   * by the manifest), never into the LISTING_REF body (its schema is
   * `additionalProperties: false`).
   */
  tags: string[];
  /** Member LISTING_REF sources: file paths or http(s) URLs. */
  members: string[];
  /** Download member catalogs and re-seed / archive them (mirror semantics). */
  reseed: boolean;
  /** Interval for auto-refresh; null means manual (`POST /refresh`) only. */
  refresh_interval_ms: number | null;
  /** Indexer base URLs to announce the topic catalog LISTING_REF to. */
  announce_to: string[];
  /** Announce tracker URLs used when downloading / re-seeding member catalogs. */
  trackers: string[];
  /** Enable DHT peer discovery during reseed (default true; false for tests). */
  dht: boolean;
  announce_timeout_ms: number;
  announce_retries: number;
}

/**
 * HTTP catalog archive served by `GET /catalog` and `GET /catalogs/:hash`.
 * Mirrors the M8 demo-indexer shape `{ manifest, files: [{ path, content(base64) }] }`
 * so an indexer mirror can store it byte-identically.
 */
export interface CatalogArchive {
  manifest: Manifest;
  files: { path: string; content: string }[];
}

/** One verified member, summarised into the synthesized topic catalog. */
export interface MemberSummary {
  publisher: string;
  catalog_id: string;
  catalog_hash: string;
  item_id: string;
  item_revision?: number;
  /** Relative path of this member's LISTING_REF copy inside the topic catalog. */
  ref_file: string;
}

/** A configured member that was excluded (fetch/verify failure) and logged. */
export interface RejectedMember {
  ref: string;
  reason: string;
}

/** Outcome of re-seeding one member catalog (only populated when reseed is on). */
export interface ReseedOutcome {
  publisher: string;
  catalog_hash: string;
  /** magnet URI of the integrator's own re-seed; null when reseed did not happen. */
  magnetURI: string | null;
  infoHash: string | null;
  error?: string;
}

/** Result of one refresh (fetch → verify → synthesize → sign → store → reseed). */
export interface RefreshResult {
  objectId: string;
  catalogHash: string;
  listingRef: SignedFile;
  archive: CatalogArchive;
  members: MemberSummary[];
  rejected: RejectedMember[];
  reseed: ReseedOutcome[];
}

/** Handle returned by the integrator role's `start()`. */
export interface IntegratorHandle {
  stop(): Promise<void>;
  port: number;
  /** Re-run the pipeline (fetch → synthesize → sign → store → reseed) and announce. */
  refresh(): Promise<RefreshResult>;
  /** The currently published result, or null before the first refresh. */
  current(): RefreshResult | null;
}
