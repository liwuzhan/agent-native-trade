/**
 * broadcast.ts — trade_broadcast_receipt。
 *
 * 把已签 TRADE_RECEIPT 打包成证据包（receipt.json + canonical manifest）并用
 * bt-catalog 做种（dht 关闭；配置了本地 tracker 时带 announce URL）。返回
 * object_id + magnet URI —— 对方凭 magnet 下载（下载侧接线留给 M8，登记 FUTURE）。
 *
 * 红线不变：只打包经过验证的 TRADE_RECEIPT；signer 显式给出时用本地私钥增签
 * （多签不破旧签），绝无任意字节签名。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildManifest, seed } from '@agent-trade/bt-catalog';
import { addSignature, objectId } from '@agent-trade/signed-files';
import { resolveEnvelope } from '@agent-trade/mcp-server/shared';

import type { DshApp } from '../app.js';
import { isPlainObject } from '../contract.js';

const MAGNET_CAP = 400;

export async function tradeBroadcastReceipt(args: Record<string, unknown>, app: DshApp): Promise<Record<string, unknown>> {
  const receipt = resolveEnvelope(app, args.receipt, args.object_id, 'broadcast_receipt');
  if (receipt.object_type !== 'TRADE_RECEIPT') {
    throw new Error(`broadcast_receipt: expected a TRADE_RECEIPT object, got ${JSON.stringify(receipt.object_type)}`);
  }

  // 显式 signer → 本地私钥增签（验签后落库，putObject 内部四步验签）
  let signed = receipt;
  const signer = typeof args.signer === 'string' && args.signer.length > 0 ? args.signer : undefined;
  if (signer !== undefined) {
    const secretKey = app.secretKeyOf(signer);
    if (secretKey === undefined) {
      throw new Error(`broadcast_receipt: no private key for "${signer}" under .data/keys/`);
    }
    signed = addSignature(receipt, signer, secretKey);
  }
  const id = objectId(signed);
  app.store.putObject(signed);

  // 证据包：receipt.json + canonical manifest
  const bundleDir = join(app.dir, '.data', 'bundles', id);
  mkdirSync(bundleDir, { recursive: true });
  const receiptBytes = new TextEncoder().encode(JSON.stringify(signed, null, 2) + '\n');
  writeFileSync(join(bundleDir, 'receipt.json'), receiptBytes);
  const manifest = buildManifest([{ path: 'receipt.json', data: receiptBytes }]);

  // 做种（dht 关；本地 tracker 可选）—— 覆盖同 id 旧做种
  const announce = app.localTracker !== undefined ? `http://127.0.0.1:${app.localTracker}/announce` : undefined;
  const previous = app.seeds.get(id);
  if (previous !== undefined) await previous().catch(() => undefined);
  const result = await seed(bundleDir, {
    dht: false,
    ...(announce !== undefined ? { tracker: [announce] } : {}),
  });
  app.seeds.set(id, result.stop);

  if (result.magnetURI.length > MAGNET_CAP) {
    throw new Error(`broadcast_receipt: magnet URI too long (${result.magnetURI.length} chars) — internal error`);
  }
  return {
    object_id: id,
    magnet_uri: result.magnetURI,
    ...(announce !== undefined ? { tracker: announce } : {}),
    bundle_files: manifest.files.map((f) => f.path),
    status: 'seeded',
  };
}

/** 供测试/验收复用：检查某个路径是否已是合法 TRADE_RECEIPT 信封（不校验签名）。 */
export function looksLikeReceiptEnvelope(value: unknown): boolean {
  return isPlainObject(value) && value.object_type === 'TRADE_RECEIPT' && Array.isArray(value.signatures);
}
