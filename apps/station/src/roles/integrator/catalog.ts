/**
 * @agent-trade/station — topic catalog synthesis (module S4).
 *
 * Aggregates the verified member LISTING_REFs into a synthesized topic catalog
 * directory held in memory: a root `catalog.json` (theme, members summary,
 * `metadata.tags`) plus one `members/<i>.json` per member (the member's
 * LISTING_REF re-serialized to canonical JCS). The directory is then built into
 * a canonical M4 manifest and its `catalog_hash`, and wrapped in the
 * M8-compatible `{ manifest, files: [{ path, content(base64) }] }` archive.
 *
 * Tags live in `catalog.json` `metadata.tags` (hash-protected by the manifest),
 * never in the LISTING_REF body (its schema is `additionalProperties: false`).
 */

import { buildManifest, catalogHash } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';
import { serialize } from '@agent-trade/signed-files';

import type { VerifiedMember } from './members.js';
import type { CatalogArchive, MemberSummary } from './types.js';

export interface TopicCatalog {
  catalog_id: string;
  item_id: string;
  theme: string;
  members: MemberSummary[];
  manifest: Manifest;
  catalogHash: string;
  archive: CatalogArchive;
}

export interface BuildTopicCatalogOptions {
  agentId: string;
  theme: string;
  tags: string[];
  members: VerifiedMember[];
}

/** Stable member ordering: publisher, then catalog_hash (byte order). */
function compareMembers(a: VerifiedMember, b: VerifiedMember): number {
  if (a.publisher < b.publisher) return -1;
  if (a.publisher > b.publisher) return 1;
  if (a.catalog_hash < b.catalog_hash) return -1;
  if (a.catalog_hash > b.catalog_hash) return 1;
  return 0;
}

export function buildTopicCatalog(opts: BuildTopicCatalogOptions): TopicCatalog {
  const sorted = [...opts.members].sort(compareMembers);

  const summaries: MemberSummary[] = sorted.map((member, index) => ({
    publisher: member.publisher,
    catalog_id: member.catalog_id,
    catalog_hash: member.catalog_hash,
    item_id: member.item_id,
    ...(member.item_revision !== undefined ? { item_revision: member.item_revision } : {}),
    ref_file: `members/${index}.json`,
  }));

  // The topic catalog's own identity: catalog_id is stable for this integrator
  // + theme across refreshes (the indexer correlates listing refs by
  // catalog_hash, so only content changes move object_id).
  const catalogId = `${opts.agentId}:${opts.theme}`;
  const catalogJson = {
    catalog_id: catalogId,
    item_id: opts.theme,
    item_revision: 0,
    theme: opts.theme,
    members: summaries,
    metadata: { tags: opts.tags },
  };

  const encoder = new TextEncoder();
  const entries: { path: string; data: Uint8Array }[] = [
    { path: 'catalog.json', data: encoder.encode(JSON.stringify(catalogJson, null, 2) + '\n') },
  ];
  sorted.forEach((member, index) => {
    entries.push({ path: `members/${index}.json`, data: encoder.encode(serialize(member.listingRef)) });
  });

  const manifest = buildManifest(entries);
  const hash = catalogHash(manifest);
  const archive: CatalogArchive = {
    manifest,
    files: entries.map((entry) => ({
      path: entry.path,
      content: Buffer.from(entry.data).toString('base64'),
    })),
  };

  return {
    catalog_id: catalogId,
    item_id: opts.theme,
    theme: opts.theme,
    members: summaries,
    manifest,
    catalogHash: hash,
    archive,
  };
}
