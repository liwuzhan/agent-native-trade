#!/usr/bin/env node
/**
 * assertions.mjs — S5 三角色互演演示逐步断言（在 demo.mjs 之后运行）。
 *
 * 读取 runlog/demo-summary.json 与 runlog/artifacts/ 下的签名文件，逐条验证：
 *   - verifyFile valid（发布站/整合商 LISTING_REF、DEAL、双方回执）
 *   - 标签命中（tag=朝阳&tag=家电维修 → 发布站目录；tag=北京&tag=家电维修 → 专题目录）
 *   - 评分非零（索引站快照里 subject 评分 > 0）
 *   - 离线快照 valid（verifySnapshot + demo-indexer CLI 离线查询）
 *   - 杀 publisher 后 indexer 镜像仍可供目录
 * 任何一条失败即非零退出。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicKeyFromSeed } from '@agent-trade/identity';
import { objectId, parse, verifyFile } from '@agent-trade/signed-files';
import { catalogHash, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import { parseDetachedSignature, parseSnapshot, querySnapshot, verifySnapshot } from '@agent-trade/demo-indexer';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(ROOT, '..', '..', '..', 'protocol', 'test-vectors', 'vectors.json');
const SUMMARY_PATH = join(ROOT, 'runlog', 'demo-summary.json');
const ART = join(ROOT, 'runlog', 'artifacts');

const BUYER = 'agent_buyer';
const SELLER = 'agent_seller';
const INTEGRATOR = 'agent_integrator';
const INTEGRATOR_SEED = 'SYJNK8ViLRxRrc_wqiBT4QgobUFWTk4iKIJkLy4s8uQ';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

let failures = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function step(n, title, fn) {
  console.log(`\n[步骤 ${n}] ${title}`);
  try {
    fn();
  } catch (err) {
    check(`${title}（执行抛错）`, false, err instanceof Error ? err.message : String(err));
  }
}

function readArtifact(name) {
  const p = join(ART, name);
  if (!existsSync(p)) throw new Error(`artifact 不存在：${name}`);
  return readFileSync(p, 'utf8');
}

function archiveToFiles(body) {
  return body.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
}

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------

if (!existsSync(SUMMARY_PATH)) {
  console.error(`❌ 未找到 ${SUMMARY_PATH} —— 请先运行 node demo.mjs（或 bash station-demo.sh）`);
  process.exit(1);
}
const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
const buyerSeed = vectors.identities.agent_buyer.seed;
const sellerSeed = vectors.identities.agent_seller.seed;

const KEYS = new Map([
  [BUYER, buyerSeed],
  [SELLER, sellerSeed],
  [INTEGRATOR, INTEGRATOR_SEED],
]);
const resolveKey = (signer) => {
  const k = KEYS.get(signer);
  return k === undefined ? undefined : publicKeyFromSeed(k);
};

console.log(`S5 断言 · ports=${JSON.stringify(summary.ports)}\n`);

// ---------------------------------------------------------------------------
// 步骤 1 — 发布站 LISTING_REF
// ---------------------------------------------------------------------------

step(1, '发布站 LISTING_REF 验签', () => {
  const st = summary.steps['2'];
  const listing = parse(readArtifact('01-listing-publisher.signed.json'));
  check('verifyFile valid', verifyFile(listing, resolveKey) === 'valid');
  check('签名者为 agent_seller', listing.signatures[0]?.signer === SELLER);
  check('object_id 与摘要一致', objectId(listing) === st.publisher_object_id);
  check('catalog_hash 与摘要一致', listing.body.catalog_hash === st.publisher_catalog_hash);
  check('distribution_refs 含 https 镜像', (listing.body.distribution_refs ?? []).some((r) => r.type === 'https'));

  // 发布站目录 manifest 校验（archive 与 catalog_hash 一致）。
  const archive = JSON.parse(readArtifact('03-catalog-publisher.archive.json'));
  check('发布站目录 archive manifest 校验通过', verifyCatalogFiles(archiveToFiles(archive), archive.manifest));
  check('发布站目录 catalog_hash 一致', catalogHash(archive.manifest) === st.publisher_catalog_hash);
  const catalogJson = JSON.parse(Buffer.from(archive.files.find((f) => f.path.endsWith('/catalog.json') || f.path === 'catalog.json').content, 'base64').toString('utf8'));
  check('发布站 catalog.json tags = 朝阳+家电维修', JSON.stringify(catalogJson.metadata.tags) === JSON.stringify(['朝阳', '家电维修']));
});

// ---------------------------------------------------------------------------
// 步骤 2 — 整合商专题目录
// ---------------------------------------------------------------------------

step(2, '整合商合成"北京家电维修专题"', () => {
  const st = summary.steps['3'];
  const listing = parse(readArtifact('02-listing-integrator.signed.json'));
  check('verifyFile valid', verifyFile(listing, resolveKey) === 'valid');
  check('签名者为 agent_integrator', listing.signatures[0]?.signer === INTEGRATOR);
  check('object_id 与摘要一致', objectId(listing) === st.integrator_object_id);
  check('catalog_hash 与摘要一致', listing.body.catalog_hash === st.topic_catalog_hash);

  const archive = JSON.parse(readArtifact('03-catalog-topic.archive.json'));
  check('专题目录 archive manifest 校验通过', verifyCatalogFiles(archiveToFiles(archive), archive.manifest));
  check('专题目录 catalog_hash 一致', catalogHash(archive.manifest) === st.topic_catalog_hash);
  const catalogJson = JSON.parse(Buffer.from(archive.files.find((f) => f.path === 'catalog.json').content, 'base64').toString('utf8'));
  check('主题 = 北京家电维修专题', catalogJson.theme === '北京家电维修专题');
  check('专题 tags = 北京+家电维修', JSON.stringify(catalogJson.metadata.tags) === JSON.stringify(['北京', '家电维修']));
  check('专题含 1 个 member（发布站）', Array.isArray(catalogJson.members) && catalogJson.members.length === 1 && catalogJson.members[0]?.publisher === SELLER);
});

// ---------------------------------------------------------------------------
// 步骤 3 — 标签检索命中 + 镜像下载
// ---------------------------------------------------------------------------

step(3, '标签检索命中 + 买方从镜像下载', () => {
  const st = summary.steps['5'];
  const chaoyang = st.search_chaoyang_hits;
  check('tag=朝阳&tag=家电维修 命中发布站目录', chaoyang.some((c) => c.catalog_hash === summary.steps['2'].publisher_catalog_hash));
  const beijing = st.search_beijing_hits;
  check('tag=北京&tag=家电维修 命中专题目录', beijing.some((c) => c.catalog_hash === summary.steps['3'].topic_catalog_hash));

  const mirror = JSON.parse(readArtifact('04-catalog-from-mirror.json'));
  check('镜像取回目录 manifest 校验通过', verifyCatalogFiles(archiveToFiles(mirror), mirror.manifest));
  check('镜像取回目录 catalog_hash 一致', catalogHash(mirror.manifest) === summary.steps['2'].publisher_catalog_hash);
});

// ---------------------------------------------------------------------------
// 步骤 4 — DEAL + 双方回执
// ---------------------------------------------------------------------------

step(4, 'DEAL 双签 + 双方回执', () => {
  const st = summary.steps['6'];
  const deal = parse(readArtifact('06-deal.signed.json'));
  check('DEAL verifyFile valid（双公钥）', verifyFile(deal, resolveKey) === 'valid');
  check('DEAL 双签：signatures.length === 2', deal.signatures.length === 2);
  const signers = new Set(deal.signatures.map((s) => s.signer));
  check('DEAL 签名者为 buyer+seller', signers.has(BUYER) && signers.has(SELLER));
  check('DEAL object_id 与摘要一致', objectId(deal) === st.deal_object_id);
  check('DEAL subject.listing_ref = 发布站 LISTING_REF', deal.body.subject.listing_ref === summary.steps['2'].publisher_object_id);

  const settlement = parse(readArtifact('07-payment-confirmed.signed.json'));
  check('结算事件 verifyFile valid', verifyFile(settlement, resolveKey) === 'valid');
  check('结算事件 object_id 与摘要一致', objectId(settlement) === st.settlement_event_object_id);

  const br = parse(readArtifact('10-receipt-buyer.signed.json'));
  const sr = parse(readArtifact('10-receipt-seller.signed.json'));
  check('买方回执 verifyFile valid', verifyFile(br, resolveKey) === 'valid');
  check('卖方回执 verifyFile valid', verifyFile(sr, resolveKey) === 'valid');
  check('买方回执 subject=seller / direction=buyer_to_seller', br.body.subject === SELLER && br.body.direction === 'buyer_to_seller');
  check('卖方回执 subject=buyer / direction=seller_to_buyer', sr.body.subject === BUYER && sr.body.direction === 'seller_to_buyer');
  check('回执 contract_hash = DEAL object_id', br.body.contract_hash === st.deal_object_id && sr.body.contract_hash === st.deal_object_id);
  check('回执 evidence.deal_ref.object_id = DEAL object_id', br.body.evidence.deal_ref.object_id === st.deal_object_id && sr.body.evidence.deal_ref.object_id === st.deal_object_id);
  check('回执 evidence.bundle 含 DEAL', Array.isArray(br.body.evidence.bundle) && objectId(br.body.evidence.bundle[0]) === st.deal_object_id);
  check('回执 evidence.settlement_event_ref = 结算事件', br.body.evidence.settlement_event_ref === st.settlement_event_object_id);
  check('双方回执 object_id 与摘要一致', objectId(br) === st.buyer_receipt_object_id && objectId(sr) === st.seller_receipt_object_id);
});

// ---------------------------------------------------------------------------
// 步骤 5 — 快照导出 + 离线查询
// ---------------------------------------------------------------------------

step(5, '快照导出 + 杀 indexer 后离线查询', () => {
  const st = summary.steps['7'];
  const snap = parseSnapshot(readFileSync(join(ROOT, st.snapshot_file), 'utf8'));
  const sig = parseDetachedSignature(readFileSync(join(ROOT, st.sig_file), 'utf8'));
  check('快照签名验证通过（verifySnapshot valid）', verifySnapshot(snap, sig) === 'valid');
  check('快照携带站点公钥（离线自证）', typeof snap.body.indexer_public_key === 'string' && snap.body.indexer_public_key.length === 43);

  const viewSeller = querySnapshot(snap, SELLER);
  const viewBuyer = querySnapshot(snap, BUYER);
  check('快照含 seller 视图（买方回执）', viewSeller !== undefined && viewSeller.receipt_count === 1);
  check('快照含 buyer 视图（卖方回执）', viewBuyer !== undefined && viewBuyer.receipt_count === 1);
  check('评分非零（seller score > 0）', typeof viewSeller?.score === 'number' && viewSeller.score > 0);
  check('评分非零（buyer score > 0）', typeof viewBuyer?.score === 'number' && viewBuyer.score > 0);

  const oq = st.offline_query;
  check('CLI 离线查询 exit=0', oq?.exit === 0);
  check('CLI 离线查询 verified=valid', oq?.verified === 'valid');
  check('CLI 离线查询 score 非零', typeof oq?.score === 'number' && oq.score > 0);
});

// ---------------------------------------------------------------------------
// 步骤 6 — 杀 publisher 后镜像仍可供目录
// ---------------------------------------------------------------------------

step(6, '杀 publisher 后 indexer 镜像仍可供目录', () => {
  const st = summary.steps['8'];
  check('flags.publisher_killed', summary.flags.publisher_killed === true);
  check('镜像取回 status=200 且校验通过', st.mirror_after_publisher_death?.status === 200 && st.mirror_after_publisher_death?.ok === true);
  check('flags.indexer_mirror_serves_after_publisher_death', summary.flags.indexer_mirror_serves_after_publisher_death === true);
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? '🎉 全部断言通过' : `❌ ${failures} 项断言失败`}`);
if (failures > 0) process.exit(1);
