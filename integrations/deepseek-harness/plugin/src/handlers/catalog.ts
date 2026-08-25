/** Catalog discovery: public indexers by default, explicit local directories for development. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { catalogHash } from '@agent-trade/bt-catalog';
import type { Manifest } from '@agent-trade/bt-catalog';
import { parseEmailContact } from '@agent-trade/contact-core';
import type { ContactRef } from '@agent-trade/contact-core';
import { sha256Hex } from '@agent-trade/identity';
import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile, VerifyResult } from '@agent-trade/signed-files';

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';
import { indexerJson, indexerUrlsFromArgs, normalizeIndexerUrls } from '../indexers.js';

const MAX_ITEM_BYTES = 32 * 1024;
const MAX_REF_BYTES = 64 * 1024;
const MAX_FILES = 500;
const TITLE_CAP = 60;
const DESC_CAP = 100;
const PRICE_CAP = 24;
const REF_URI_CAP = 128;
const REMOTE_LIMIT = 2;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function catalogDirOf(args: Record<string, unknown>, app: DshApp): string {
  const dir = typeof args.catalog_dir === 'string' && args.catalog_dir.length > 0 ? args.catalog_dir : app.catalogDir;
  if (dir.length === 0) throw new Error('no catalog_dir configured');
  return dir;
}

function readJsonCap(path: string, maxBytes: number): unknown {
  if (!existsSync(path)) return undefined;
  const size = statSync(path).size;
  if (size > maxBytes) throw new Error(`catalog file too large (${size} bytes > ${maxBytes}): ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function strField(value: unknown, key: string, cap: number): string {
  if (!isPlainObject(value)) return '';
  const field = value[key];
  if (typeof field !== 'string') return '';
  return field.length > cap ? field.slice(0, cap) : field;
}

function priceField(item: Record<string, unknown>): string {
  const price = item.price;
  if (typeof price === 'string') return price.slice(0, PRICE_CAP);
  if (isPlainObject(price)) {
    const amount = typeof price.amount === 'string' ? price.amount : '';
    const currency = typeof price.currency === 'string' ? price.currency : '';
    return (amount.length > 0 ? (currency.length > 0 ? `${amount} ${currency}` : amount) : '').slice(0, PRICE_CAP);
  }
  return '';
}

function tagsOf(item: Record<string, unknown>): string[] {
  const direct = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const metadata = isPlainObject(item.metadata) && Array.isArray(item.metadata.tags)
    ? item.metadata.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return [...new Set([...direct, ...metadata])];
}

function contactRefsOf(item: Record<string, unknown>): { t: string; u: string; p?: string }[] {
  if (!Array.isArray(item.contact_refs)) return [];
  const out: { t: string; u: string; p?: string }[] = [];
  for (const value of item.contact_refs) {
    if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.uri !== 'string') continue;
    try {
      const parsed = parseEmailContact(value as unknown as ContactRef);
      out.push({ t: 'email', u: parsed.uri.slice(0, REF_URI_CAP), p: parsed.profile?.slice(0, 40) });
      break;
    } catch {
      // Ignore malformed or unsupported contact refs instead of exposing them as callable addresses.
    }
  }
  return out;
}

function distributionRefsOf(body: Record<string, unknown> | undefined): { t: string; u: string }[] {
  if (body === undefined || !Array.isArray(body.distribution_refs)) return [];
  const out: { t: string; u: string }[] = [];
  for (const value of body.distribution_refs) {
    if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.uri !== 'string') continue;
    out.push({ t: value.type.slice(0, 20), u: value.uri.slice(0, REF_URI_CAP) });
    if (out.length >= 1) break;
  }
  return out;
}

function refPathOf(dir: string, itemId: string): string {
  return join(dir, `${itemId}.listing-ref.json`);
}

interface MatchSummary {
  i: string;
  t: string;
  p: string;
  o: string;
}

function localCatalogSearch(args: Record<string, unknown>, app: DshApp, query: string): Record<string, unknown> {
  const dir = catalogDirOf(args, app);
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 4;
  const keywords = query.toLowerCase().split(/\s+/).filter((keyword) => keyword.length > 0);
  const matches: MatchSummary[] = [];
  let scanned = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.listing-ref.json')) continue;
    if (++scanned > MAX_FILES) break;
    const itemId = name.slice(0, -'.json'.length);
    let item: unknown;
    try {
      item = readJsonCap(join(dir, name), MAX_ITEM_BYTES);
    } catch {
      continue;
    }
    if (!isPlainObject(item)) continue;
    const haystack = [strField(item, 'title', TITLE_CAP), strField(item, 'description', DESC_CAP), ...tagsOf(item)]
      .join(' ')
      .toLowerCase();
    if (!keywords.every((keyword) => haystack.includes(keyword))) continue;

    let refId = '';
    try {
      const ref = readJsonCap(refPathOf(dir, itemId), MAX_REF_BYTES);
      if (ref !== undefined && isPlainObject(ref) && ref.object_type === 'LISTING_REF') {
        const file = ref as unknown as SignedFile;
        if (verifyFile(file, app.resolveKey) === 'valid') refId = objectId(file);
      }
    } catch {
      refId = '';
    }
    matches.push({ i: itemId, t: strField(item, 'title', TITLE_CAP), p: priceField(item), o: refId });
    if (matches.length >= 50) break;
  }
  const shown = matches.slice(0, limit);
  return { object_id: shown[0]?.o ?? '', matches: shown, count: matches.length, source: 'local' };
}

interface RemoteHit {
  hash: string;
  objectId: string;
  itemId: string;
  tags: string[];
  base: string;
}

interface RemoteDetail {
  item: Record<string, unknown>;
  listingRef: SignedFile | undefined;
  listingVerify: VerifyResult | 'missing';
}

function parseCatalogCard(value: unknown, expectedHash: string, app: DshApp): RemoteDetail {
  if (!isPlainObject(value) || !isPlainObject(value.catalog)) throw new Error('invalid catalog card');
  const catalog = value.catalog;
  if (!isPlainObject(catalog.manifest) || !isPlainObject(catalog.catalog_json)) throw new Error('invalid catalog card');
  const manifest = catalog.manifest as unknown as Manifest;
  if (catalogHash(manifest) !== expectedHash) throw new Error('catalog card manifest hash mismatch');
  const entry = catalog.catalog_json;
  if (typeof entry.path !== 'string' || typeof entry.content !== 'string') throw new Error('invalid catalog_json entry');
  if (entry.path !== 'catalog.json' && !/^[^/]+\/catalog\.json$/.test(entry.path)) throw new Error('invalid catalog_json path');
  const manifestEntry = manifest.files.find((file) => file.path === entry.path);
  if (manifestEntry === undefined) throw new Error('catalog_json missing from manifest');
  const bytes = Buffer.from(entry.content, 'base64');
  if (bytes.toString('base64') !== entry.content || sha256Hex(bytes) !== manifestEntry.sha256) {
    throw new Error('catalog_json content hash mismatch');
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!isPlainObject(parsed)) throw new Error('catalog_json must be an object');
  const listingRef = isPlainObject(value.listing_ref) && value.listing_ref.object_type === 'LISTING_REF'
    ? value.listing_ref as unknown as SignedFile
    : undefined;
  return {
    item: parsed,
    listingRef,
    listingVerify: listingRef === undefined ? 'missing' : verifyFile(listingRef, app.resolveKey),
  };
}

async function fetchRemoteDetail(base: string, hash: string, app: DshApp): Promise<RemoteDetail> {
  const response = await indexerJson(base, `catalogs/${encodeURIComponent(hash)}/card`);
  if (!response.ok) throw new Error(`catalog card HTTP ${response.status}`);
  return parseCatalogCard(response.value, hash, app);
}

function remoteHits(value: unknown, base: string): RemoteHit[] {
  if (!isPlainObject(value) || !Array.isArray(value.catalogs)) throw new Error('invalid catalog search response');
  const out: RemoteHit[] = [];
  for (const raw of value.catalogs) {
    if (!isPlainObject(raw) || typeof raw.catalog_hash !== 'string' || !HASH_RE.test(raw.catalog_hash)) continue;
    out.push({
      hash: raw.catalog_hash,
      objectId: typeof raw.object_id === 'string' && HASH_RE.test(raw.object_id) ? raw.object_id : '',
      itemId: typeof raw.item_id === 'string' ? raw.item_id.slice(0, 80) : '',
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [],
      base,
    });
  }
  return out;
}

function indexersOf(args: Record<string, unknown>, app: DshApp): string[] {
  if (typeof args.indexer_url === 'string') return normalizeIndexerUrls([args.indexer_url]);
  return indexerUrlsFromArgs(args.indexer_urls, app.indexerUrls);
}

async function remoteCatalogSearch(args: Record<string, unknown>, app: DshApp, query: string): Promise<Record<string, unknown>> {
  const bases = indexersOf(args, app);
  if (bases.length === 0) throw new Error('no indexer configured; set AGENT_TRADE_INDEXERS or pass catalog_dir');
  const tags = query.split(/\s+/).filter((tag) => tag.length > 0);
  const suffix = tags.map((tag) => `tag=${encodeURIComponent(tag)}`).join('&');
  const seen = new Set<string>();
  const hits: RemoteHit[] = [];
  let successful = 0;
  const failures: string[] = [];
  const searches = await Promise.all(bases.map(async (base) => {
    try {
      const response = await indexerJson(base, `catalogs${suffix.length > 0 ? `?${suffix}` : ''}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { base, hits: remoteHits(response.value, base) };
    } catch (error) {
      return { base, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  for (const search of searches) {
    if ('error' in search) {
      failures.push(`${search.base}: ${search.error}`);
      continue;
    }
    successful++;
    for (const hit of search.hits) {
      if (seen.has(hit.hash)) continue;
      seen.add(hit.hash);
      hits.push(hit);
    }
  }
  if (successful === 0) throw new Error(`all indexers failed: ${failures.join('; ').slice(0, 240)}`);

  const requested = typeof args.limit === 'number' && Number.isInteger(args.limit)
    ? Math.min(REMOTE_LIMIT, Math.max(1, args.limit))
    : REMOTE_LIMIT;
  const shown = hits.slice(0, requested);
  const sources = [...new Set(shown.map((hit) => hit.base))];
  const matches = await Promise.all(shown.map(async (hit) => {
    let title = hit.tags.join('/').slice(0, 40);
    let price = '';
    try {
      const detail = await fetchRemoteDetail(hit.base, hit.hash, app);
      title = strField(detail.item, 'title', 40) || title;
      price = priceField(detail.item);
    } catch {
      // A search hit remains useful when the optional detail fetch fails.
    }
    return { i: hit.itemId, t: title, p: price, o: hit.objectId, h: hit.hash, s: sources.indexOf(hit.base) };
  }));
  return { object_id: matches[0]?.o ?? '', matches, count: hits.length, sources };
}

export async function catalogSearch(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) throw new Error('catalog_search: "query" is required');
  if (typeof args.catalog_dir === 'string' && args.catalog_dir.length > 0) return localCatalogSearch(args, app, query);
  return remoteCatalogSearch(args, app, query);
}

function localCatalogGetItem(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const dir = catalogDirOf(args, app);
  let itemId = typeof args.item_id === 'string' && args.item_id.length > 0 ? args.item_id : undefined;
  const requestedId = typeof args.object_id === 'string' && args.object_id.length > 0 ? args.object_id : undefined;
  if (itemId === undefined && requestedId === undefined) throw new Error('catalog_get_item: provide item_id or object_id');
  if (itemId === undefined) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.listing-ref.json')) continue;
      const candidate = name.slice(0, -'.listing-ref.json'.length);
      try {
        const raw = readJsonCap(join(dir, name), MAX_REF_BYTES);
        if (raw !== undefined && isPlainObject(raw)) {
          const file = raw as unknown as SignedFile;
          if (verifyFile(file, app.resolveKey) === 'valid' && objectId(file) === requestedId) {
            itemId = candidate;
            break;
          }
        }
      } catch {
        // Continue scanning bounded local files.
      }
    }
    if (itemId === undefined) throw new Error(`catalog_get_item: no valid LISTING_REF with object_id ${requestedId ?? '(empty)'}`);
  }

  const item = readJsonCap(join(dir, `${itemId}.json`), MAX_ITEM_BYTES);
  if (item === undefined) throw new Error(`catalog_get_item: unknown item ${itemId}`);
  if (!isPlainObject(item)) throw new Error(`catalog_get_item: item ${itemId} is not a JSON object`);
  let ref: SignedFile | undefined;
  let refVerify: VerifyResult | 'missing' = 'missing';
  try {
    const rawRef = readJsonCap(refPathOf(dir, itemId), MAX_REF_BYTES);
    if (rawRef !== undefined && isPlainObject(rawRef) && rawRef.object_type === 'LISTING_REF') {
      ref = rawRef as unknown as SignedFile;
      refVerify = verifyFile(ref, app.resolveKey);
    }
  } catch {
    ref = undefined;
  }
  const refBody = refVerify === 'valid' && ref !== undefined && isPlainObject(ref.body) ? ref.body : undefined;
  return {
    object_id: refVerify === 'valid' && ref !== undefined ? objectId(ref) : '',
    item_id: itemId,
    title: strField(item, 'title', TITLE_CAP),
    description: strField(item, 'description', DESC_CAP),
    price: priceField(item),
    catalog_hash: refBody !== undefined && typeof refBody.catalog_hash === 'string' ? refBody.catalog_hash : '',
    contacts: contactRefsOf(item),
    distribution_refs: distributionRefsOf(refBody),
    listing_ref_verify: refVerify,
  };
}

async function locateRemoteHit(args: Record<string, unknown>, app: DshApp, bases: string[]): Promise<RemoteHit> {
  const requestedHash = typeof args.catalog_hash === 'string' && HASH_RE.test(args.catalog_hash) ? args.catalog_hash : undefined;
  const requestedObject = typeof args.object_id === 'string' ? args.object_id : undefined;
  const requestedItem = typeof args.item_id === 'string' ? args.item_id : undefined;
  if (requestedHash !== undefined) {
    return { hash: requestedHash, objectId: requestedObject ?? '', itemId: requestedItem ?? '', tags: [], base: bases[0]! };
  }
  if (requestedObject === undefined && requestedItem === undefined) {
    throw new Error('catalog_get_item: provide catalog_hash, object_id, or item_id');
  }
  for (const base of bases) {
    try {
      const response = await indexerJson(base, 'catalogs');
      if (!response.ok) continue;
      const hit = remoteHits(response.value, base).find((candidate) =>
        (requestedObject !== undefined && candidate.objectId === requestedObject)
        || (requestedItem !== undefined && candidate.itemId === requestedItem));
      if (hit !== undefined) return hit;
    } catch {
      // Try the next configured indexer.
    }
  }
  throw new Error('catalog_get_item: item not found on configured indexers');
}

async function remoteCatalogGetItem(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const bases = indexersOf(args, app);
  if (bases.length === 0) throw new Error('no indexer configured; set AGENT_TRADE_INDEXERS or pass catalog_dir');
  const located = await locateRemoteHit(args, app, bases);
  const ordered = [located.base, ...bases.filter((base) => base !== located.base)];
  let lastError = 'not found';
  for (const base of ordered) {
    try {
      const detail = await fetchRemoteDetail(base, located.hash, app);
      return {
        object_id: detail.listingRef !== undefined ? objectId(detail.listingRef) : located.objectId,
        i: strField(detail.item, 'item_id', 64) || located.itemId,
        t: strField(detail.item, 'title', 50),
        d: strField(detail.item, 'description', 72),
        p: priceField(detail.item),
        h: located.hash,
        c: contactRefsOf(detail.item).map(({ t, u }) => ({ t, u })),
        v: detail.listingVerify,
        x: base,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`catalog_get_item: ${lastError}`);
}

export async function catalogGetItem(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  if (typeof args.catalog_dir === 'string' && args.catalog_dir.length > 0) return localCatalogGetItem(args, app);
  return remoteCatalogGetItem(args, app);
}
