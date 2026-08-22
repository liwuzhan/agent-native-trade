/**
 * assertions.mjs — M11 演示逐步断言（在 demo.mjs 之后运行）。
 *
 * 读取 runlog/demo-summary.json（object_id / 文件路径 / 状态 / 评分全量记录）
 * 与 runlog/artifacts/ 下的签名文件，逐条验证 11 步。任何一步失败即
 * 非零退出，最终打印 PASS/FAIL 汇总。
 *
 * 运行：node assertions.mjs（run-demo.sh 在 demo.mjs 后自动调用）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicKeyFromSeed } from '@agent-trade/identity';
import { objectId, parse, verifyFile } from '@agent-trade/signed-files';
import { openStore } from '@agent-trade/local-store';
import { buildManifest, catalogHash, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import { parseDetachedSignature, parseSnapshot, querySnapshot, verifySnapshot } from '@agent-trade/demo-indexer';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(ROOT, '..', '..', 'protocol', 'test-vectors', 'vectors.json');
const SUMMARY_PATH = join(ROOT, 'runlog', 'demo-summary.json');
const ART = join(ROOT, 'runlog', 'artifacts');
const BUYER_DIR = join(ROOT, 'runlog', 'buyer');
const SELLER_DIR = join(ROOT, 'runlog', 'seller');

const BUYER = 'agent_buyer';
const SELLER = 'agent_seller';
const INTEGRATOR = 'agent_integrator';
const INTEGRATOR_SEED = 'Y_8Fq-yMB8zfF0kuIX6_CEq49gAv27xk38uqd0jqJ1I';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

let failures = 0;
const detailLines = [];

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

/** 递归读取目录文件（与 demo.mjs 同构）。 */
function readDirFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...readDirFiles(p, `${prefix}${name}/`));
    else out.push({ path: `${prefix}${name}`, data: new Uint8Array(readFileSync(p)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------

if (!existsSync(SUMMARY_PATH)) {
  console.error(`❌ 未找到 ${SUMMARY_PATH} —— 请先运行 node demo.mjs（或 bash run-demo.sh）`);
  process.exit(1);
}
const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
const buyerSeed = vectors.identities.agent_buyer.seed;
const sellerSeed = vectors.identities.agent_seller.seed;
const TRADE_ID = summary.trade_id;

const KEYS = new Map([
  [BUYER, buyerSeed],
  [SELLER, sellerSeed],
  [INTEGRATOR, INTEGRATOR_SEED],
]);
const resolveKey = (signer) => {
  const k = KEYS.get(signer);
  return k === undefined ? undefined : publicKeyFromSeed(k);
};

console.log(`M11 断言 · mode=${summary.mode} · trade_id=${TRADE_ID}\n`);

// ---------------------------------------------------------------------------
// 步骤 1 — 卖方发布目录
// ---------------------------------------------------------------------------

step(1, '卖方发布目录', () => {
  const st = summary.steps['1'];
  check('LISTING_REF object_id 已记录', typeof st?.listing_object_id === 'string' && st.listing_object_id.startsWith('sha256:'));
  const listing = parse(readArtifact('01-listing-seller.signed.json'));
  check('LISTING_REF verifyFile valid（卖方密钥）', verifyFile(listing, resolveKey) === 'valid');
  check('签名者为 agent_seller', listing.signatures[0]?.signer === SELLER);
  check('object_id 与摘要一致', objectId(listing) === st.listing_object_id);

  // 目录 manifest 重算比对 catalog_hash。
  const files = readDirFiles(join(ROOT, 'seller', 'catalog'));
  const manifest = buildManifest(files.map((f) => ({ path: `catalog/${f.path}`, data: f.data })));
  check('body.catalog_hash 与 manifest 重算一致', listing.body.catalog_hash === catalogHash(manifest));
  check('body.catalog_hash 与摘要一致', listing.body.catalog_hash === st.catalog_hash);

  const refs = listing.body.distribution_refs ?? [];
  check('distribution_refs 含 magnet', refs.some((r) => r.type === 'magnet' && typeof r.uri === 'string'));
  check('distribution_refs 含 email', refs.some((r) => r.type === 'email' && r.uri === `mailto:seller@doll-studio.example`));
  check('catalog 文件数 = 5（seller/catalog）', manifest.files.length === 5);
});

// ---------------------------------------------------------------------------
// 步骤 2 — 整合商专题目录
// ---------------------------------------------------------------------------

step(2, '整合商专题目录', () => {
  const st = summary.steps['2'];
  const listing = parse(readArtifact('02-listing-integrator.signed.json'));
  check('专题 LISTING_REF verifyFile valid（整合商密钥）', verifyFile(listing, resolveKey) === 'valid');
  check('签名者为 agent_integrator', listing.signatures[0]?.signer === INTEGRATOR);
  check('专题 object_id 与摘要一致', objectId(listing) === st.listing_object_id);

  const files = readDirFiles(join(ROOT, 'runlog', 'themed'));
  const manifest = buildManifest(files.map((f) => ({ path: `themed/${f.path}`, data: f.data })));
  check('专题 catalog_hash 与 manifest 重算一致', listing.body.catalog_hash === catalogHash(manifest));

  const trace = summary.mail_trace ?? [];
  check('整合商已邮件通告买方（专题）', trace.some((m) => m.from === 'integrator@spring-theme.example' && m.to === 'buyer@momo.example' && m.subject.includes('2026 春季棉花娃娃专题')));
  check('通告附带了卖方 LISTING_REF', trace.some((m) => m.from === 'integrator@spring-theme.example' && (m.attachments ?? []).includes('01-listing-seller.signed.json')));
  check('专题目录文件 ≥ 2（theme.json + notes）', manifest.files.length >= 2);
});

// ---------------------------------------------------------------------------
// 步骤 3 — 检索站收录 / 下线 / 镜像
// ---------------------------------------------------------------------------

step(3, '检索站收录 + 卖方/tracker 下线 + HTTP 镜像取回', () => {
  const st = summary.steps['3'];
  check('卖方目录已存档（HTTP 镜像 201 已记录）', existsSync(join(ART, '03-catalog-archive-seller.json')));
  const archive = JSON.parse(readArtifact('03-catalog-archive-seller.json'));
  const archiveFiles = archive.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
  check('存档包文件逐字节匹配 manifest（verifyCatalogFiles）', verifyCatalogFiles(archiveFiles, archive.manifest) === true);
  check('存档包 catalog_hash 与 manifest 一致', catalogHash(archive.manifest) === summary.steps['1'].catalog_hash);

  check('卖方已下线（flags.seller_offline）', summary.flags.seller_offline === true);
  check('tracker 已下线（flags.tracker_offline）', summary.flags.tracker_offline === true);
  check('镜像取回发生在下线之后（flags.mirror_after_offline）', summary.flags.mirror_after_offline === true);

  const mirror = JSON.parse(readArtifact('04-catalog-from-mirror.json'));
  const mirrorFiles = mirror.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
  check('镜像取回的目录 manifest 校验通过', verifyCatalogFiles(mirrorFiles, mirror.manifest) === true);
  check('镜像取回的 catalog_hash 与卖方发布一致（离线存档角色）', catalogHash(mirror.manifest) === summary.steps['1'].catalog_hash);

  // BT 下载超时/失败时演示已降级到检索站 HTTP 镜像；任一路径必须内容哈希 === catalog_hash。
  check('卖方目录取得（bt 或 [fallback] http-mirror）内容哈希 === catalog_hash', st.seller_dl?.ok === true);
  check('专题目录取得（bt 或 [fallback] http-mirror）内容哈希 === catalog_hash', st.theme_dl?.ok === true);
  for (const [key, file, expectedHash] of [
    ['seller_dl', '05-catalog-seller-from-mirror.json', summary.steps['1'].catalog_hash],
    ['theme_dl', '05-catalog-theme-from-mirror.json', summary.steps['2'].catalog_hash],
  ]) {
    if (st[key]?.path === 'http-mirror') {
      const fb = JSON.parse(readArtifact(file));
      const fbFiles = fb.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
      check(`${key} [fallback] http-mirror 取回包哈希 === catalog_hash`, verifyCatalogFiles(fbFiles, fb.manifest) === true && catalogHash(fb.manifest) === expectedHash);
    }
  }
});

// ---------------------------------------------------------------------------
// 步骤 4 — 买方找到并联系
// ---------------------------------------------------------------------------

step(4, '买方找到并联系卖方', () => {
  const st = summary.steps['4'];
  check('buyer_contacted_seller 已置位', st.buyer_contacted_seller === true);
  const trace = summary.mail_trace ?? [];
  check('买方已发出询价邮件', trace.some((m) => m.from === 'buyer@momo.example' && m.to === 'seller@doll-studio.example' && m.subject.includes('inquiry')));
  check('询价邮件带 X-Trade-Id 关联', trace.some((m) => m.from === 'buyer@momo.example' && m.tradeId === TRADE_ID));

  // 买方 store 已收录两份 LISTING_REF（从整合商通告附件）。
  const store = openStore(BUYER_DIR);
  try {
    check('买方 store 已收录卖方 LISTING_REF', store.getObject(summary.steps['1'].listing_object_id) !== undefined);
    check('买方 store 已收录专题 LISTING_REF', store.getObject(summary.steps['2'].listing_object_id) !== undefined);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 步骤 5 — 议价
// ---------------------------------------------------------------------------

step(5, '议价（邮件三封）', () => {
  const neg = summary.steps['5']?.negotiation ?? [];
  check('议价往来 ≥ 3 封', neg.length >= 3);
  const subjects = neg.map((n) => n.subject);
  check('含询价', subjects.some((s) => s.includes('inquiry')));
  check('含报价', subjects.some((s) => s.includes('quote')));
  check('含接受', subjects.some((s) => s.includes('accept')));
  const iInquiry = subjects.findIndex((s) => s.includes('inquiry'));
  const iQuote = subjects.findIndex((s) => s.includes('quote'));
  const iAccept = subjects.findIndex((s) => s.includes('accept'));
  check('顺序：询价 → 报价 → 接受', iInquiry >= 0 && iQuote > iInquiry && iAccept > iQuote);
});

// ---------------------------------------------------------------------------
// 步骤 6 — 双签合同
// ---------------------------------------------------------------------------

step(6, '双签合同（MCP 起草/审签 + 双方 DEAL_SIGNED）', () => {
  const st = summary.steps['6'];
  const deal = parse(readArtifact('06-deal.signed.json'));
  check('DEAL verifyFile valid（四步验签，双公钥）', verifyFile(deal, resolveKey) === 'valid');
  check('双签：signatures.length === 2', deal.signatures.length === 2);
  const signers = new Set(deal.signatures.map((s) => s.signer));
  check('签名者为 买方+卖方', signers.has(BUYER) && signers.has(SELLER));
  check('DEAL object_id 与摘要一致', objectId(deal) === st.deal_object_id);
  check('买方 MCP 起草成功（compile）', st.buyer_mcp_compile_ok === true);
  check('卖方 MCP 记录 DEAL_SIGNED → AGREED', st.seller_mcp_recorded_state === 'AGREED');
  check('买方账本 DEAL_SIGNED → AGREED', st.buyer_state === 'AGREED');
  check('卖方账本 DEAL_SIGNED → AGREED', st.seller_state === 'AGREED');
  check('buyer_deal_signed_event 已记录', typeof st.buyer_deal_signed_event === 'string' && st.buyer_deal_signed_event.startsWith('sha256:'));

  const buyerStore = openStore(BUYER_DIR);
  const sellerStore = openStore(SELLER_DIR);
  try {
    const buyerDeal = buyerStore.getObject(st.deal_object_id);
    const sellerDeal = sellerStore.getObject(st.deal_object_id);
    check('买方 store 持有双签 DEAL', buyerDeal !== undefined && buyerDeal.signatures.length === 2);
    check('卖方 store 持有双签 DEAL', sellerDeal !== undefined && sellerDeal.signatures.length === 2);
    check('卖方 store 持有其 DEAL_SIGNED 事件', sellerStore.getObject(st.seller_deal_signed_event) !== undefined);
    check('买方 store 持有其 DEAL_SIGNED 事件', buyerStore.getObject(st.buyer_deal_signed_event) !== undefined);
  } finally {
    buyerStore.close();
    sellerStore.close();
  }
});

// ---------------------------------------------------------------------------
// 步骤 7 — 钱包/人类支付
// ---------------------------------------------------------------------------

step(7, '钱包/人类支付（manual-settlement + M7 PAY 任务）', () => {
  const st = summary.steps['7'];
  const req = parse(readArtifact('07-payment-requested.signed.json'));
  const conf = parse(readArtifact('07-payment-confirmed.signed.json'));
  check('PAYMENT_REQUESTED verifyFile valid', verifyFile(req, resolveKey) === 'valid');
  check('PAYMENT_CONFIRMED verifyFile valid', verifyFile(conf, resolveKey) === 'valid');
  check('event_type = PAYMENT_REQUESTED（actor=买方）', req.body.event_type === 'PAYMENT_REQUESTED' && req.body.actor === BUYER);
  check('event_type = PAYMENT_CONFIRMED（actor=卖方）', conf.body.event_type === 'PAYMENT_CONFIRMED' && conf.body.actor === SELLER);
  check('事件 trade_id 一致', req.body.trade_id === TRADE_ID && conf.body.trade_id === TRADE_ID);
  check('两个事件 object_id 不同且已记录', st.payment_requested_event !== st.payment_confirmed_event);
  check('PAYMENT_REQUESTED 事件引用 task_id', typeof req.body.evidence?.task_id === 'string' && req.body.evidence.task_id === st.pay_task_id);

  check('PAY 任务文件存在', existsSync(st.pay_task_file));
  const task = JSON.parse(readFileSync(st.pay_task_file, 'utf8'));
  check('PAY 任务已 DONE（人工完成被演示自动标记）', task.status === 'DONE');
  check('PAY 任务结果含支付回执', typeof task.result?.payment_reference === 'string' && task.result.payment_reference.length > 0);
  check('状态链：买方 PAYMENT_CONFIRMED', st.buyer_state === 'PAYMENT_CONFIRMED');
  check('状态链：卖方 PAYMENT_CONFIRMED', st.seller_state === 'PAYMENT_CONFIRMED');
});

// ---------------------------------------------------------------------------
// 步骤 8 — 人类生产验货发货
// ---------------------------------------------------------------------------

step(8, '人类生产验货发货（PRODUCE → FULFILLING，SHIP → SHIPPED）', () => {
  const st = summary.steps['8'];
  const fl = parse(readArtifact('08-fulfilling.signed.json'));
  const sh = parse(readArtifact('08-shipped.signed.json'));
  check('FULFILLING verifyFile valid（卖方签发）', verifyFile(fl, resolveKey) === 'valid' && fl.body.actor === SELLER);
  check('SHIPPED verifyFile valid（卖方签发）', verifyFile(sh, resolveKey) === 'valid' && sh.body.actor === SELLER);
  check('event_type 正确', fl.body.event_type === 'FULFILLING' && sh.body.event_type === 'SHIPPED');
  check('FULFILLING 事件携带生产任务结果', fl.body.evidence?.task_type === 'PRODUCE' && fl.body.evidence?.result?.serial_no === 'CDS-2026-0001');
  check('SHIPPED 事件携带验货/运单结果', sh.body.evidence?.result?.inspected === true && typeof sh.body.evidence?.result?.tracking_no === 'string');

  for (const [id, label] of [[st.produce_task_id, 'PRODUCE'], [st.ship_task_id, 'SHIP']]) {
    const p = join(SELLER_DIR, '.data', 'tasks', `${id}.json`);
    check(`${label} 任务文件存在且 DONE`, existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).status === 'DONE');
  }
  check('状态链：买方 SHIPPED', st.buyer_state === 'SHIPPED');
  check('状态链：卖方 SHIPPED', st.seller_state === 'SHIPPED');
});

// ---------------------------------------------------------------------------
// 步骤 9 — 物流签收事件
// ---------------------------------------------------------------------------

step(9, '物流签收事件（RECEIVE → DELIVERED）', () => {
  const st = summary.steps['9'];
  const dl = parse(readArtifact('09-delivered.signed.json'));
  check('DELIVERED verifyFile valid（买方签发）', verifyFile(dl, resolveKey) === 'valid' && dl.body.actor === BUYER);
  check('event_type = DELIVERED', dl.body.event_type === 'DELIVERED');
  check('DELIVERED 携带签收结果', dl.body.evidence?.task_type === 'RECEIVE' && dl.body.evidence?.result?.received === true && dl.body.evidence?.result?.intact === true);
  const p = join(BUYER_DIR, '.data', 'tasks', `${st.receive_task_id}.json`);
  check('RECEIVE 任务文件存在且 DONE', existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).status === 'DONE');
  check('状态链：买方 DELIVERED', st.buyer_state === 'DELIVERED');
  check('状态链：卖方 DELIVERED', st.seller_state === 'DELIVERED');
});

// ---------------------------------------------------------------------------
// 步骤 10 — 双方签名评价广播
// ---------------------------------------------------------------------------

step(10, '双方签名评价广播（COMPLETED + 回执双收录）', () => {
  const st = summary.steps['10'];
  const cp = parse(readArtifact('10-completed.signed.json'));
  check('COMPLETED verifyFile valid（买方签发）', verifyFile(cp, resolveKey) === 'valid' && cp.body.actor === BUYER);
  check('event_type = COMPLETED', cp.body.event_type === 'COMPLETED');
  check('COMPLETED 证据含最终验收', cp.body.evidence?.final_acceptance === true);

  const br = parse(readArtifact('10-receipt-buyer.signed.json'));
  const sr = parse(readArtifact('10-receipt-seller.signed.json'));
  check('买方回执 verifyFile valid', verifyFile(br, resolveKey) === 'valid');
  check('卖方回执 verifyFile valid', verifyFile(sr, resolveKey) === 'valid');
  check('回执 result=COMPLETED / rating=POSITIVE', br.body.result === 'COMPLETED' && br.body.rating === 'POSITIVE' && sr.body.result === 'COMPLETED' && sr.body.rating === 'POSITIVE');
  check('回执 subject 互评', br.body.subject === SELLER && br.body.direction === 'buyer_to_seller' && sr.body.subject === BUYER && sr.body.direction === 'seller_to_buyer');
  check('contract_hash = DEAL object_id', br.body.contract_hash === summary.steps['6'].deal_object_id && sr.body.contract_hash === summary.steps['6'].deal_object_id);
  check('evidence.deal_ref.object_id = DEAL object_id', br.body.evidence?.deal_ref?.object_id === summary.steps['6'].deal_object_id && sr.body.evidence?.deal_ref?.object_id === summary.steps['6'].deal_object_id);
  check('evidence.settlement_event_ref = PAYMENT_CONFIRMED', br.body.evidence?.settlement_event_ref === summary.steps['7'].payment_confirmed_event && sr.body.evidence?.settlement_event_ref === summary.steps['7'].payment_confirmed_event);
  check('evidence.bundle 内含 DEAL（可离线验签）', Array.isArray(br.body.evidence?.bundle) && br.body.evidence.bundle.length === 1 && objectId(br.body.evidence.bundle[0]) === summary.steps['6'].deal_object_id);

  const subs = st.receipt_submissions ?? {};
  check('回执在检索站 A 收录（双方）', subs.buyer_to_a === 'indexed' && subs.seller_to_a === 'indexed');
  check('回执在整合商 B 收录（双方）', subs.buyer_to_b === 'indexed' && subs.seller_to_b === 'indexed');
  check('两个权重配置产生不同评分（A=70, B=80）', st.scores.buyer_to_seller.a === 70 && st.scores.buyer_to_seller.b === 80 && st.scores.buyer_to_seller.a !== st.scores.buyer_to_seller.b);
  check('双方账本终态 COMPLETED', st.buyer_state === 'COMPLETED' && st.seller_state === 'COMPLETED');

  // 重开 store：状态机持久化断言。
  const buyerStore = openStore(BUYER_DIR);
  const sellerStore = openStore(SELLER_DIR);
  try {
    check('重开买方 store：stateOf === COMPLETED', buyerStore.stateOf(TRADE_ID) === 'COMPLETED');
    check('重开卖方 store：stateOf === COMPLETED', sellerStore.stateOf(TRADE_ID) === 'COMPLETED');
    // 每个事件都落库：双方账本各 7 个 TRADE_EVENT 事实文件。
    const countEvents = (dir) => {
      const objectsDir = join(dir, '.data', 'objects', 'sha256');
      if (!existsSync(objectsDir)) return 0;
      let n = 0;
      for (const name of readdirSync(objectsDir)) {
        if (!name.endsWith('.json')) continue;
        const f = JSON.parse(readFileSync(join(objectsDir, name), 'utf8'));
        if (f.object_type === 'TRADE_EVENT') n += 1;
      }
      return n;
    };
    check('买方账本 7 个事件全部落库', countEvents(BUYER_DIR) === 7);
    check('卖方账本 7 个事件全部落库', countEvents(SELLER_DIR) === 7);
  } finally {
    buyerStore.close();
    sellerStore.close();
  }
});

// ---------------------------------------------------------------------------
// 步骤 11 — 独立整合商收录 + 静态导出 + 离线查询
// ---------------------------------------------------------------------------

step(11, '独立整合商收录 + 静态导出 + 离线查询', () => {
  const st = summary.steps['11'];
  const snapA = parseSnapshot(readFileSync(st.snapshots['indexer-a'].snapshot_file, 'utf8'));
  const sigA = parseDetachedSignature(readFileSync(st.snapshots['indexer-a'].sig_file, 'utf8'));
  const snapB = parseSnapshot(readFileSync(st.snapshots['integrator-b'].snapshot_file, 'utf8'));
  const sigB = parseDetachedSignature(readFileSync(st.snapshots['integrator-b'].sig_file, 'utf8'));

  check('检索站 A 快照签名验证通过', verifySnapshot(snapA, sigA) === 'valid');
  check('整合商 B 快照签名验证通过', verifySnapshot(snapB, sigB) === 'valid');
  check('两个索引器使用不同权重配置（weights_hash 不同）', snapA.body.weights_hash !== snapB.body.weights_hash);

  const viewASeller = querySnapshot(snapA, SELLER);
  const viewABuyer = querySnapshot(snapA, BUYER);
  const viewBSeller = querySnapshot(snapB, SELLER);
  const viewBBuyer = querySnapshot(snapB, BUYER);
  check('检索站 A 收录双方回执（seller/buyer 均有 subject 视图）', viewASeller?.receipt_count === 1 && viewABuyer?.receipt_count === 1);
  check('整合商 B 收录双方回执（独立整合商收录）', viewBSeller?.receipt_count === 1 && viewBBuyer?.receipt_count === 1);
  check('同一 subject 在两个索引器评分不同（70 vs 80）', viewASeller.score === 70 && viewBSeller.score === 80 && viewASeller.score !== viewBSeller.score);

  // 离线 CLI 查询（demo.mjs 已在杀服务器后执行）。
  const oq = st.offline_queries ?? {};
  check('离线查询 indexer-a：exit=0 + verified=valid + score=70', oq['indexer-a']?.exit === 0 && oq['indexer-a']?.verified === 'valid' && oq['indexer-a']?.score === 70);
  check('离线查询 integrator-b：exit=0 + verified=valid + score=80', oq['integrator-b']?.exit === 0 && oq['integrator-b']?.verified === 'valid' && oq['integrator-b']?.score === 80);
  check('CLI export→query 路径可用', st.cli_export_ok === true && oq['cli-indexer-a']?.exit === 0 && oq['cli-indexer-a']?.verified === 'valid');

  // 静态文件可离线自证：快照 body 内携带站点公钥。
  check('快照携带站点公钥（离线自证）', typeof snapA.body.indexer_public_key === 'string' && snapA.body.indexer_public_key.length === 43);
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? '🎉 全部断言通过' : `❌ ${failures} 项断言失败`}`);
if (failures > 0) process.exit(1);
