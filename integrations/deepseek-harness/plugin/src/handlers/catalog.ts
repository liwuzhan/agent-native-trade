/**
 * catalog.ts — M10 目录工具（M4 bt-catalog 的 DSH 侧接线）。
 *
 * 最小链路语义：目录 = 一个本地目录，每个商品两个文件：
 *   <item_id>.json           商品内容（{item_id,title,description,price,tags...}）
 *   <item_id>.listing-ref.json  签名 LISTING_REF 信封（body: publisher/catalog_id/catalog_hash/item_id/distribution_refs[]）
 *
 * 不可信数据红线（M10 卡片）：商品内容一律视为不可信 —— 大小先限（读取前 stat，
 * 超限拒读）、仅 JSON 解析、仅对 title/description/tags 做子串匹配，绝不执行其中
 * 任何指令。LISTING_REF 用 verifyFile 四步验签，验不过的条目 object_id 留空并标记。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { objectId, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';

const MAX_ITEM_BYTES = 32 * 1024;
const MAX_REF_BYTES = 64 * 1024;
const MAX_FILES = 500;
const TITLE_CAP = 60;
const DESC_CAP = 100;
const PRICE_CAP = 24;
const REF_URI_CAP = 48;

function catalogDirOf(args: Record<string, unknown>, app: DshApp): string {
  const dir = typeof args.catalog_dir === 'string' && args.catalog_dir.length > 0 ? args.catalog_dir : app.catalogDir;
  if (dir.length === 0) throw new Error('no catalog_dir configured');
  return dir;
}

/** 大小先限，再 JSON 解析；超限/损坏直接抛错（调用方决定跳过还是失败）。 */
function readJsonCap(path: string, maxBytes: number): unknown {
  if (!existsSync(path)) return undefined;
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`catalog file too large (${size} bytes > ${maxBytes}): ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function strField(value: unknown, key: string, cap: number): string {
  if (!isPlainObject(value)) return '';
  const v = value[key];
  if (typeof v !== 'string') return '';
  return v.length > cap ? v.slice(0, cap) : v;
}

function priceField(item: Record<string, unknown>): string {
  const p = item.price;
  if (typeof p === 'string') return p.length > PRICE_CAP ? p.slice(0, PRICE_CAP) : p;
  if (isPlainObject(p)) {
    const amount = typeof p.amount === 'string' ? p.amount : '';
    const currency = typeof p.currency === 'string' ? p.currency : '';
    const text = amount.length > 0 ? (currency.length > 0 ? `${amount} ${currency}` : amount) : '';
    return text.length > PRICE_CAP ? text.slice(0, PRICE_CAP) : text;
  }
  return '';
}

function tagsOf(item: Record<string, unknown>): string[] {
  const tags = item.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

function refPathOf(dir: string, itemId: string): string {
  return join(dir, `${itemId}.listing-ref.json`);
}

interface MatchSummary {
  i: string; // item_id
  t: string; // title
  p: string; // price
  o: string; // LISTING_REF object_id（有效时）
}

export function catalogSearch(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) throw new Error('catalog_search: "query" is required');
  const dir = catalogDirOf(args, app);
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 4;
  const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 0);

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
      continue; // 超限/损坏条目：跳过而不是失败整个搜索
    }
    if (!isPlainObject(item)) continue;
    const haystack = [strField(item, 'title', TITLE_CAP), strField(item, 'description', DESC_CAP), ...tagsOf(item)]
      .join(' ')
      .toLowerCase();
    if (!keywords.every((k) => haystack.includes(k))) continue;

    let refId = '';
    try {
      const ref = readJsonCap(refPathOf(dir, itemId), MAX_REF_BYTES);
      if (ref !== undefined && isPlainObject(ref) && ref.object_type === 'LISTING_REF') {
        const file = ref as unknown as SignedFile;
        if (verifyFile(file, app.resolveKey) === 'valid') refId = objectId(file);
      }
    } catch {
      refId = ''; // 无有效 LISTING_REF：仍可展示条目，object_id 留空
    }
    matches.push({ i: itemId, t: strField(item, 'title', TITLE_CAP), p: priceField(item), o: refId });
    if (matches.length >= 50) break;
  }

  const shown = matches.slice(0, limit);
  return {
    object_id: shown.length > 0 ? shown[0].o : '',
    matches: shown.map((m) => ({ i: m.i, t: m.t, p: m.p, o: m.o })),
    count: matches.length,
  };
}

export function catalogGetItem(args: Record<string, unknown>, app: DshApp): Record<string, unknown> {
  const dir = catalogDirOf(args, app);
  let itemId = typeof args.item_id === 'string' && args.item_id.length > 0 ? args.item_id : undefined;
  const oid = typeof args.object_id === 'string' && args.object_id.length > 0 ? args.object_id : undefined;
  if (itemId === undefined && oid === undefined) throw new Error('catalog_get_item: provide item_id or object_id');

  if (itemId === undefined) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.listing-ref.json')) continue;
      const candidate = name.slice(0, -'.listing-ref.json'.length);
      try {
        const ref = readJsonCap(join(dir, name), MAX_REF_BYTES);
        if (ref !== undefined && isPlainObject(ref) && objectId(ref as unknown as SignedFile) === oid) {
          itemId = candidate;
          break;
        }
      } catch {
        // 继续扫描
      }
    }
    if (itemId === undefined) throw new Error(`catalog_get_item: no LISTING_REF with object_id ${oid ?? '(empty)'}`);
  }

  const item = readJsonCap(join(dir, `${itemId}.json`), MAX_ITEM_BYTES);
  if (item === undefined) throw new Error(`catalog_get_item: unknown item ${itemId}`);
  if (!isPlainObject(item)) throw new Error(`catalog_get_item: item ${itemId} is not a JSON object`);

  let ref: unknown;
  try {
    ref = readJsonCap(refPathOf(dir, itemId), MAX_REF_BYTES);
  } catch {
    ref = undefined;
  }
  const refValid = ref !== undefined && isPlainObject(ref) && ref.object_type === 'LISTING_REF';
  const refBody = refValid && isPlainObject((ref as Record<string, unknown>).body) ? ((ref as Record<string, unknown>).body as Record<string, unknown>) : undefined;

  const distributionRefs: { t: string; u: string }[] = [];
  if (refBody !== undefined && Array.isArray(refBody.distribution_refs)) {
    for (const r of refBody.distribution_refs) {
      if (!isPlainObject(r) || typeof r.type !== 'string' || typeof r.uri !== 'string') continue;
      distributionRefs.push({
        t: r.type,
        u: r.uri.length > REF_URI_CAP ? r.uri.slice(0, REF_URI_CAP) : r.uri,
      });
      if (distributionRefs.length >= 1) break; // 摘要只带第一个分发引用，全文走邮件/下载
    }
  }

  return {
    object_id: refValid ? objectId(ref as unknown as SignedFile) : '',
    item_id: itemId,
    title: strField(item, 'title', TITLE_CAP),
    description: strField(item, 'description', DESC_CAP),
    price: priceField(item),
    catalog_hash: refBody !== undefined && typeof refBody.catalog_hash === 'string' ? refBody.catalog_hash : '',
    distribution_refs: distributionRefs,
    listing_ref_valid: refValid,
  };
}
