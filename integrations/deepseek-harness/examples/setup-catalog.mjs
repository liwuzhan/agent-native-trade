/**
 * setup-catalog.mjs — 演示目录/身份预置（零依赖，node 内建 + 本仓库包）。
 *
 * 在 ~/.agent-trade/ 下准备：
 *   buyer/.data/keys/agent_buyer       买方私钥（0600）
 *   buyer/.data/peers/agent_seller.pub 卖方公钥（信任环只读导入）
 *   seller/.data/keys/agent_seller     卖方私钥
 *   seller/.data/peers/agent_buyer.pub 买方公钥
 *   catalog/                           两个商品（<item_id>.json + 签名 LISTING_REF）
 *   maildrop/                          邮件 spool（买卖双方子目录，运行时创建）
 *
 * LISTING_REF 用卖方私钥真实签名（canonical manifest → catalogHash）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 依赖经插件包 node_modules 的 file URL 导入（examples/ 自身不装依赖）
const pkg = (name) => new URL(`../plugin/node_modules/@agent-trade/${name}/dist/index.js`, import.meta.url).href;
const { generateIdentity } = await import(pkg('identity'));
const { addSignature, buildObject } = await import(pkg('signed-files'));
const { buildManifest, catalogHash } = await import(pkg('bt-catalog'));

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const ROOT = process.env.AGENT_TRADE_DEMO_ROOT ?? join(HOME, '.agent-trade');

const buyerDir = join(ROOT, 'buyer');
const sellerDir = join(ROOT, 'seller');
const catalogDir = join(ROOT, 'catalog');
const maildropDir = join(ROOT, 'maildrop');

function saveIdentity(dir, agentId, identity) {
  const keys = join(dir, '.data', 'keys');
  mkdirSync(keys, { recursive: true });
  // M3 约定：键文件名为 encodeURIComponent(agentId) + '.key'
  writeFileSync(join(keys, encodeURIComponent(agentId) + '.key'), identity.secretKey, { mode: 0o600 });
  return identity;
}

function savePeerKey(dir, agentId, publicKey) {
  const peers = join(dir, '.data', 'peers');
  mkdirSync(peers, { recursive: true });
  writeFileSync(join(peers, `${agentId}.pub`), publicKey, 'utf8');
}

const buyer = saveIdentity(buyerDir, 'agent_buyer', generateIdentity());
const seller = saveIdentity(sellerDir, 'agent_seller', generateIdentity());
savePeerKey(buyerDir, 'agent_seller', seller.publicKey);
savePeerKey(sellerDir, 'agent_buyer', buyer.publicKey);

mkdirSync(catalogDir, { recursive: true });
mkdirSync(maildropDir, { recursive: true });

const items = [
  {
    itemId: 'bolt-m8',
    data: { item_id: 'bolt-m8', title: 'M8 不锈钢螺栓', description: '304 材质 40mm，每包 100 颗', price: { amount: '12.00', currency: 'CNY' }, tags: ['螺栓', '五金'] },
  },
  {
    itemId: 'doll-cotton',
    data: { item_id: 'doll-cotton', title: '棉花娃娃', description: '20cm 定制玩偶，可换装', price: { amount: '66.00', currency: 'CNY' }, tags: ['玩偶', '定制'] },
  },
];

const manifestFiles = [];
for (const item of items) {
  const bytes = new TextEncoder().encode(JSON.stringify(item.data, null, 2) + '\n');
  writeFileSync(join(catalogDir, `${item.itemId}.json`), bytes);
  manifestFiles.push({ path: `${item.itemId}.json`, data: bytes });
}
const manifest = buildManifest(manifestFiles);
const hash = catalogHash(manifest);

for (const item of items) {
  const ref = addSignature(
    buildObject('LISTING_REF', {
      publisher: 'agent_seller',
      catalog_id: 'demo-catalog',
      catalog_hash: hash,
      item_id: item.itemId,
      distribution_refs: [{ type: 'file', uri: `catalog/${item.itemId}.json` }],
    }),
    'agent_seller',
    seller.secretKey,
  );
  writeFileSync(join(catalogDir, `${item.itemId}.listing-ref.json`), JSON.stringify(ref, null, 2) + '\n');
}

console.log(JSON.stringify({ root: ROOT, catalogDir, maildropDir, buyer: 'agent_buyer', seller: 'agent_seller', catalog_hash: hash }, null, 2));
