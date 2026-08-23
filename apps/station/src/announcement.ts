/**
 * Transport-level announcement used by stations.
 *
 * The four signed protocol objects remain unchanged. This wrapper only carries
 * enough public material for an indexer to verify a previously unseen signer
 * and index a catalog without mirroring the complete archive.
 */

import { catalogHash } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';
import { sha256Hex } from '@agent-trade/identity';
import type { SignedFile } from '@agent-trade/signed-files';

export interface CatalogCard {
  manifest: Manifest;
  catalog_json: {
    path: string;
    /** Standard base64 encoded bytes, exactly as listed in the manifest. */
    content: string;
  };
}

export interface ListingAnnouncement {
  identity: {
    agent_id: string;
    public_key: string;
  };
  listing_ref: SignedFile;
  catalog: CatalogCard;
}

interface ArchiveLike {
  manifest: Manifest;
  files: { path: string; content: string }[];
}

const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCatalogJsonPath(path: string): boolean {
  return path === 'catalog.json' || /^[^/]+\/catalog\.json$/.test(path);
}

export function buildListingAnnouncement(
  agentId: string,
  publicKey: string,
  listingRef: SignedFile,
  archive: ArchiveLike,
): ListingAnnouncement {
  const entry = archive.files.find((file) => isCatalogJsonPath(file.path));
  if (entry === undefined) {
    throw new Error('catalog archive has no catalog.json');
  }
  return {
    identity: { agent_id: agentId, public_key: publicKey },
    listing_ref: listingRef,
    catalog: {
      manifest: archive.manifest,
      catalog_json: { path: entry.path, content: entry.content },
    },
  };
}

export function isListingAnnouncement(value: unknown): value is ListingAnnouncement {
  if (!isRecord(value) || !isRecord(value['identity']) || !isRecord(value['catalog'])) return false;
  const identity = value['identity'];
  const catalog = value['catalog'];
  return (
    typeof identity['agent_id'] === 'string' &&
    identity['agent_id'].length > 0 &&
    typeof identity['public_key'] === 'string' &&
    PUBKEY_RE.test(identity['public_key']) &&
    isRecord(value['listing_ref']) &&
    isRecord(catalog['manifest']) &&
    isRecord(catalog['catalog_json']) &&
    typeof catalog['catalog_json']['path'] === 'string' &&
    typeof catalog['catalog_json']['content'] === 'string'
  );
}

/** Verify the compact card against the catalog hash and return its tags. */
export function verifyCatalogCard(card: CatalogCard, expectedCatalogHash: string): string[] | null {
  if (catalogHash(card.manifest) !== expectedCatalogHash) {
    throw new Error('catalog manifest hash does not match LISTING_REF');
  }

  const { path, content } = card.catalog_json;
  if (!isCatalogJsonPath(path)) {
    throw new Error('catalog_json path must be catalog.json at the root or one directory deep');
  }
  const manifestEntry = card.manifest.files.find((entry) => entry.path === path);
  if (manifestEntry === undefined) {
    throw new Error('catalog_json is not present in the manifest');
  }

  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) {
    throw new Error('catalog_json content is not canonical base64');
  }
  if (sha256Hex(bytes) !== manifestEntry.sha256) {
    throw new Error('catalog_json content hash does not match the manifest');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('catalog_json is not valid JSON');
  }
  if (!isRecord(parsed)) return null;
  const metadata = parsed['metadata'];
  if (!isRecord(metadata) || metadata['tags'] === undefined) return null;
  const tags = metadata['tags'];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('catalog_json metadata.tags must be an array of strings');
  }
  return tags as string[];
}
