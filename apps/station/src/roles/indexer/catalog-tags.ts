/**
 * @agent-trade/station — catalog tag extraction (module S2).
 *
 * The LISTING_REF body schema is `additionalProperties: false`, so tags cannot
 * ride on the announce envelope without breaking the signature. Tags therefore
 * live inside the catalog content itself: a `catalog.json` file whose
 * `metadata.tags` is a `string[]`. That file's bytes are covered by the
 * manifest, and `storeCatalog` verifies every file against the manifest before
 * this runs, so the extracted tags are hash-protected self-description.
 *
 * The publisher (module S3) prefixes archive paths with the catalog directory
 * basename, so the self-description arrives as `<basename>/catalog.json`. Both
 * that convention and a flat root `catalog.json` are recognised.
 *
 * A catalog without a `catalog.json` (or without `metadata.tags`) yields `null`
 * and is simply absent from the yellow pages while remaining in the mirror.
 */

interface CatalogArchiveFile {
  path?: unknown;
  content?: unknown;
}

interface CatalogArchive {
  manifest?: unknown;
  files?: CatalogArchiveFile[];
}

/** True for `catalog.json` at the archive root or one directory level deep. */
function isCatalogJsonPath(path: string): boolean {
  return path === 'catalog.json' || /^[^/]+\/catalog\.json$/.test(path);
}

/** Extract the tag list from the `catalog.json` member of an archive body. */
export function extractCatalogTags(rawBody: string): string[] | null {
  let archive: CatalogArchive;
  try {
    archive = JSON.parse(rawBody) as CatalogArchive;
  } catch {
    return null;
  }
  if (archive === null || typeof archive !== 'object' || !Array.isArray(archive.files)) {
    return null;
  }
  const entry = archive.files.find((f) => typeof f?.path === 'string' && isCatalogJsonPath(f.path));
  if (entry === undefined || typeof entry.content !== 'string') {
    return null;
  }

  let catalog: unknown;
  try {
    catalog = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (catalog === null || typeof catalog !== 'object') return null;
  const metadata = (catalog as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== 'object') return null;
  const tags = (metadata as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return null;
  if (!tags.every((t) => typeof t === 'string')) return null;
  return tags as string[];
}
