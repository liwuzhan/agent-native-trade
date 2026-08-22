#!/usr/bin/env node
/**
 * demo.mjs — S5 三角色互演演示（发布站 → 整合商 → 索引站 全链路）。
 *
 * 由 station-demo.sh 调用：先构建（npx tsc -b）→ 清理 runlog → 本脚本 → assertions.mjs。
 * 本脚本以 apps/station/examples/ 为工作目录，启动三个 station CLI 进程
 * （node ../dist/cli.js <role> --config configs/<role>.yaml），再走完整演示链路：
 *
 *   publisher 发布虚构"家电维修"服务目录（tags: 朝阳+家电维修）
 *     → integrator 合成"北京家电维修专题"（tags: 北京+家电维修，member 为发布站 LISTING_REF）
 *     → indexer 收录（通告 + PUT 镜像）
 *     → GET /catalogs?tag=朝阳&tag=家电维修 命中发布站目录
 *     → 买方从索引站镜像下载目录
 *     → 用测试向量身份签 DEAL + 双方回执（@agent-trade/signed-files）
 *     → 回执 POST indexer → GET /export 快照
 *     → 杀 indexer → demo-indexer CLI 离线查询验证快照
 *     → 重启 indexer → 杀 publisher → indexer 镜像仍可供目录
 *
 * 超时兜底（借鉴 M11 withTimeout）：每步 30s 硬超时；BT 播种在角色内部以 dht:false
 * 执行（无 tracker / 无 DHT，避免挂起）；HTTP 调用各自带超时。
 */

import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publicKeyFromSeed } from '@agent-trade/identity';
import {
  addSignature,
  buildObject,
  objectId,
  parse,
  serialize,
  verifyFile,
} from '@agent-trade/signed-files';
import { catalogHash, verifyCatalogFiles } from '@agent-trade/bt-catalog';

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = dirname(fileURLToPath(import.meta.url));
const STATION_DIR = join(EXAMPLES_DIR, '..');
const STATION_CLI = join(STATION_DIR, 'dist', 'cli.js');
const DEMO_INDEXER_CLI = join(EXAMPLES_DIR, '..', '..', 'demo-indexer', 'dist', 'cli.js');
const VECTORS_PATH = join(EXAMPLES_DIR, '..', '..', '..', 'protocol', 'test-vectors', 'vectors.json');

const RUN = join(EXAMPLES_DIR, 'runlog');
const ART = join(RUN, 'artifacts');
const EXPORT_DIR = join(RUN, 'export');
const IDENTITY_DIR = join(RUN, 'identity');

// 端口（与 configs/*.yaml 一致）
const INDEXER_PORT = 19781;
const PUBLISHER_PORT = 19782;
const INTEGRATOR_PORT = 19783;

const INDEXER_BASE = `http://127.0.0.1:${INDEXER_PORT}`;
const PUBLISHER_BASE = `http://127.0.0.1:${PUBLISHER_PORT}`;
const INTEGRATOR_BASE = `http://127.0.0.1:${INTEGRATOR_PORT}`;

// 身份
const BUYER = 'agent_buyer';
const SELLER = 'agent_seller';
const INTEGRATOR = 'agent_integrator';
const INDEXER = 'agent_indexer';
// 演示虚构种子（非真实秘密；整合商/索引站站点身份，固定以便复现）。
const INTEGRATOR_SEED = 'SYJNK8ViLRxRrc_wqiBT4QgobUFWTk4iKIJkLy4s8uQ';
const INDEXER_SEED = 'CRvDtLWuQAUUATZeIWYI0ICvSsb_rgplRz8x5v2znS8';

// 固定 trade_id（uuid v7，规范 §4），复现用。
const TRADE_ID = '018e2c21-0000-7000-8000-00000000000f';
// 固定签发时间（复现 object_id）。
const T0 = '2026-08-22T02:00:00Z'; // 发布站 LISTING_REF 由角色自己签（不用此常量）
const T_DEAL_BUYER = '2026-08-22T03:00:00Z';
const T_DEAL_SELLER = '2026-08-22T03:05:00Z';
const T_SETTLE = '2026-08-24T08:30:00Z';
const T_RCPT_BUYER = '2026-09-02T02:00:00Z';
const T_RCPT_SELLER = '2026-09-02T02:01:00Z';

// 超时兜底（借鉴 M11）
const STEP_TIMEOUT_MS = 30_000; // 步骤级硬超时
const BT_TIMEOUT_MS = 20_000; // BT 播种/下载超时（本演示角色内部 dht:false，仅作兜底语义保留）
const HTTP_TIMEOUT_MS = 15_000; // HTTP 调用超时

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const logLines = [];
const log = (step, msg) => {
  const line = `[${step}] ${msg}`;
  console.log(line);
  logLines.push(line);
};
const stepBanner = (n, title) => log(`步骤${n}`, `==== ${title} ====`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 给任意 Promise 加硬超时：超时抛带标签错误（绝不静默挂起）。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function httpJson(base, path, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, text, json };
}

function writeArtifact(name, text) {
  const p = join(ART, name);
  writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n', 'utf8');
  return p;
}

/** 写 32 字节原始种子文件（loadOrCreateSeed 读取 base64url 种子的原文）。 */
function writeSeedFile(relPath, seedBase64url) {
  const p = join(EXAMPLES_DIR, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(seedBase64url, 'base64url'), { mode: 0o600 });
  return p;
}

/** 预置信任环：向某角色的 .data/keys/<agentId>.key 写入（私钥）种子。 */
function writeKey(dataDir, agentId, seedBase64url) {
  const keysDir = join(dataDir, '.data', 'keys');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${encodeURIComponent(agentId)}.key`), seedBase64url + '\n', { mode: 0o600 });
}

/** 派生公钥（与 local-store 信任环同源：公钥来自种子）。 */
function pubOf(seedBase64url) {
  return publicKeyFromSeed(seedBase64url);
}

// ---------------------------------------------------------------------------
// 进程管理
// ---------------------------------------------------------------------------

const processes = [];
const roleProcs = {}; // role name -> latest child process

function startRole(name, configRel) {
  const logPath = join(RUN, `${name}.log`);
  const out = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, [STATION_CLI, name, '--config', configRel], {
    cwd: EXAMPLES_DIR,
    env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  processes.push(child);
  roleProcs[name] = child;
  return child;
}

async function waitHealthy(base, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return (await res.json());
      lastErr = `http ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(`${label} /healthz 超时（最后错误：${lastErr}）`);
}

async function stopProcess(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  log('proc', `${label} 停止（SIGTERM）…`);
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('proc', `${label} 5s 未退出，强制 SIGKILL`);
      child.kill('SIGKILL');
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 跑一个 node CLI 并捕获 stdout/stderr（用于 demo-indexer 离线查询）。 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: EXAMPLES_DIR,
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 汇总与清理
// ---------------------------------------------------------------------------

const summary = {
  ports: { indexer: INDEXER_PORT, publisher: PUBLISHER_PORT, integrator: INTEGRATOR_PORT },
  identities: {},
  steps: {},
  flags: {},
};

const cleanupAll = async () => {
  for (const child of [...processes].reverse()) {
    try {
      await stopProcess(child, 'cleanup');
    } catch {
      /* 尽力而为 */
    }
  }
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log('init', 'S5 三角色互演演示');
  for (const d of [RUN, ART, EXPORT_DIR, IDENTITY_DIR]) mkdirSync(d, { recursive: true });

  // 1. 身份：buyer/seller 种子取自协议权威测试向量；integrator/indexer 为演示固定种子。
  const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  const buyerSeed = vectors.identities.agent_buyer.seed;
  const sellerSeed = vectors.identities.agent_seller.seed;

  const KEYS = new Map([
    [BUYER, buyerSeed],
    [SELLER, sellerSeed],
    [INTEGRATOR, INTEGRATOR_SEED],
    [INDEXER, INDEXER_SEED],
  ]);
  const resolveKey = (signer) => {
    const k = KEYS.get(signer);
    return k === undefined ? undefined : publicKeyFromSeed(k);
  };

  summary.identities = {
    buyer: BUYER,
    seller: SELLER,
    integrator: INTEGRATOR,
    indexer: INDEXER,
    buyer_public_key: pubOf(buyerSeed),
    seller_public_key: pubOf(sellerSeed),
    integrator_public_key: pubOf(INTEGRATOR_SEED),
    indexer_public_key: pubOf(INDEXER_SEED),
  };

  // 2. 站点身份种子文件（32 字节原始种子，匹配 agent_id）。
  writeSeedFile('runlog/identity/indexer.seed', INDEXER_SEED);
  writeSeedFile('runlog/identity/publisher.seed', sellerSeed);
  writeSeedFile('runlog/identity/integrator.seed', INTEGRATOR_SEED);

  // 3. 信任环预置（跨进程验签需要）：
  //    - indexer 需验发布站/整合商通告、回执与 DEAL bundle → 存 buyer/seller/integrator 种子。
  //    - integrator 需验发布站 member LISTING_REF → 存 seller 种子。
  writeKey(join(RUN, 'indexer'), SELLER, sellerSeed);
  writeKey(join(RUN, 'indexer'), BUYER, buyerSeed);
  writeKey(join(RUN, 'indexer'), INTEGRATOR, INTEGRATOR_SEED);
  writeKey(join(RUN, 'integrator'), SELLER, sellerSeed);

  // 4. 发布站虚构目录（家电维修，tags: 朝阳+家电维修）。
  const publisherCatalogDir = join(RUN, 'publisher-catalog');
  mkdirSync(publisherCatalogDir, { recursive: true });
  writeFileSync(
    join(publisherCatalogDir, 'catalog.json'),
    JSON.stringify(
      {
        catalog_id: 'home-appliance-repair-chaoyang',
        item_id: 'home-appliance-repair-service',
        item_revision: 1,
        title: '朝阳区家电维修上门服务（虚构演示数据）',
        description: '上门维修冰箱/空调/洗衣机，虚构目录，仅用于演示',
        metadata: { tags: ['朝阳', '家电维修'] },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // =====================================================================
  // 步骤 1 — 起站（indexer → publisher → integrator 依序启动并等待健康）
  // =====================================================================
  await withTimeout((async () => {
    stepBanner(1, '起站（三个 CLI 进程依序启动）');

    startRole('indexer', 'configs/indexer.yaml');
    await waitHealthy(INDEXER_BASE, 'indexer');
    log('步骤1', `indexer 就绪 ${INDEXER_BASE}`);

    startRole('publisher', 'configs/publisher.yaml');
    await waitHealthy(PUBLISHER_BASE, 'publisher');
    log('步骤1', `publisher 就绪 ${PUBLISHER_BASE}（启动时已通告 indexer）`);

    startRole('integrator', 'configs/integrator.yaml');
    await waitHealthy(INTEGRATOR_BASE, 'integrator');
    log('步骤1', `integrator 就绪 ${INTEGRATOR_BASE}（启动时已抓取 member 并通告 indexer）`);
  })(), STEP_TIMEOUT_MS, '步骤1 起站');

  // =====================================================================
  // 步骤 2 — 发布站 LISTING_REF 验签
  // =====================================================================
  let publisherListing;
  let publisherObjectId;
  let publisherCatalogHash;
  await withTimeout((async () => {
    stepBanner(2, '发布站 LISTING_REF 验签（verifyFile valid）');

    const res = await httpJson(PUBLISHER_BASE, '/listing-ref');
    if (res.status !== 200) throw new Error(`发布站 /listing-ref 失败 status=${res.status}`);
    publisherListing = parse(res.text);
    if (verifyFile(publisherListing, resolveKey) !== 'valid') {
      throw new Error('发布站 LISTING_REF 验签失败');
    }
    publisherObjectId = objectId(publisherListing);
    publisherCatalogHash = publisherListing.body.catalog_hash;
    writeArtifact('01-listing-publisher.signed.json', serialize(publisherListing));
    log('步骤2', `发布站 LISTING_REF object_id=${publisherObjectId} catalog_hash=${publisherCatalogHash}`);
    log('步骤2', `tags=${JSON.stringify(publisherListing.body ? [] : [])} 签名者=${publisherListing.signatures[0]?.signer}`);
  })(), STEP_TIMEOUT_MS, '步骤2 发布站 LISTING_REF 验签');

  // =====================================================================
  // 步骤 3 — 整合商专题目录验签 + 成员校验
  // =====================================================================
  let integratorListing;
  let integratorObjectId;
  let topicCatalogHash;
  let topicArchiveBody;
  await withTimeout((async () => {
    stepBanner(3, '整合商合成"北京家电维修专题"并验签');

    const catalogRes = await httpJson(INTEGRATOR_BASE, '/catalog');
    if (catalogRes.status !== 200) throw new Error(`整合商 /catalog 失败 status=${catalogRes.status}`);
    topicArchiveBody = JSON.parse(catalogRes.text);
    const files = topicArchiveBody.files.map((f) => ({
      path: f.path,
      data: Uint8Array.from(Buffer.from(f.content, 'base64')),
    }));
    if (verifyCatalogFiles(files, topicArchiveBody.manifest) !== true) {
      throw new Error('专题目录 manifest 校验失败');
    }
    topicCatalogHash = catalogHash(topicArchiveBody.manifest);
    writeArtifact('03-catalog-topic.archive.json', catalogRes.text);

    // catalog.json 主题 + tags
    const catalogJsonEntry = topicArchiveBody.files.find((f) => f.path === 'catalog.json');
    const catalogJson = JSON.parse(Buffer.from(catalogJsonEntry.content, 'base64').toString('utf8'));
    if (catalogJson.theme !== '北京家电维修专题') throw new Error(`主题不符：${catalogJson.theme}`);
    if (catalogJson.metadata.tags.join(',') !== '北京,家电维修') {
      throw new Error(`专题 tags 不符：${catalogJson.metadata.tags}`);
    }
    if (!Array.isArray(catalogJson.members) || catalogJson.members.length !== 1) {
      throw new Error(`专题 member 数应为 1，实为 ${catalogJson.members?.length}`);
    }

    const refRes = await httpJson(INTEGRATOR_BASE, '/listing-ref');
    if (refRes.status !== 200) throw new Error(`整合商 /listing-ref 失败 status=${refRes.status}`);
    integratorListing = parse(refRes.text);
    if (verifyFile(integratorListing, resolveKey) !== 'valid') {
      throw new Error('整合商 LISTING_REF 验签失败');
    }
    integratorObjectId = objectId(integratorListing);
    writeArtifact('02-listing-integrator.signed.json', serialize(integratorListing));
    log('步骤3', `专题 catalog_hash=${topicCatalogHash} member=${catalogJson.members[0]?.publisher}`);
    log('步骤3', `整合商 LISTING_REF object_id=${integratorObjectId} 签名者=${integratorListing.signatures[0]?.signer}`);
  })(), STEP_TIMEOUT_MS, '步骤3 整合商专题目录验签');

  // =====================================================================
  // 步骤 4 — 索引站收录（PUT 镜像两份目录）
  // =====================================================================
  let publisherArchiveBody;
  await withTimeout((async () => {
    stepBanner(4, '索引站收录（PUT 镜像：发布站目录 + 专题目录）');

    const pubCatalog = await httpJson(PUBLISHER_BASE, `/catalogs/${publisherCatalogHash}`);
    if (pubCatalog.status !== 200) throw new Error(`发布站目录取回失败 status=${pubCatalog.status}`);
    publisherArchiveBody = JSON.parse(pubCatalog.text);
    writeArtifact('03-catalog-publisher.archive.json', pubCatalog.text);

    const putPub = await httpJson(INDEXER_BASE, `/catalogs/${publisherCatalogHash}`, {
      method: 'PUT',
      body: pubCatalog.text,
    });
    if (putPub.status !== 201) throw new Error(`发布站目录 PUT 镜像失败 status=${putPub.status} body=${putPub.text}`);

    const putTopic = await httpJson(INDEXER_BASE, `/catalogs/${topicCatalogHash}`, {
      method: 'PUT',
      body: JSON.stringify(topicArchiveBody),
    });
    if (putTopic.status !== 201) throw new Error(`专题目录 PUT 镜像失败 status=${putTopic.status} body=${putTopic.text}`);

    log('步骤4', `已镜像两份目录到 indexer：${publisherCatalogHash} / ${topicCatalogHash}`);
  })(), STEP_TIMEOUT_MS, '步骤4 索引站收录');

  // =====================================================================
  // 步骤 5 — 标签检索命中 + 买方下载目录
  // =====================================================================
  let searchChaoyang;
  let searchBeijing;
  let mirrorBody;
  await withTimeout((async () => {
    stepBanner(5, '标签检索命中 + 买方从镜像下载目录');

    // tag=朝阳&tag=家电维修 → 命中发布站目录（1 条）
    searchChaoyang = await httpJson(INDEXER_BASE, `/catalogs?tag=${encodeURIComponent('朝阳')}&tag=${encodeURIComponent('家电维修')}`);
    const hitsChaoyang = searchChaoyang.json?.catalogs ?? [];
    log('步骤5', `tag=朝阳&tag=家电维修 命中 ${hitsChaoyang.length} 条`);
    if (!hitsChaoyang.some((c) => c.catalog_hash === publisherCatalogHash)) {
      throw new Error(`tag=朝阳&tag=家电维修 未命中发布站目录（结果：${JSON.stringify(hitsChaoyang)}）`);
    }

    // tag=北京&tag=家电维修 → 命中专题目录（1 条）
    searchBeijing = await httpJson(INDEXER_BASE, `/catalogs?tag=${encodeURIComponent('北京')}&tag=${encodeURIComponent('家电维修')}`);
    const hitsBeijing = searchBeijing.json?.catalogs ?? [];
    log('步骤5', `tag=北京&tag=家电维修 命中 ${hitsBeijing.length} 条`);
    if (!hitsBeijing.some((c) => c.catalog_hash === topicCatalogHash)) {
      throw new Error(`tag=北京&tag=家电维修 未命中专题目录（结果：${JSON.stringify(hitsBeijing)}）`);
    }

    // 买方从索引站镜像下载发布站目录（校验 manifest + catalog_hash）。
    const mirror = await httpJson(INDEXER_BASE, `/catalogs/${publisherCatalogHash}`);
    if (mirror.status !== 200) throw new Error(`镜像取回失败 status=${mirror.status}`);
    mirrorBody = JSON.parse(mirror.text);
    const files = mirrorBody.files.map((f) => ({
      path: f.path,
      data: Uint8Array.from(Buffer.from(f.content, 'base64')),
    }));
    const ok = verifyCatalogFiles(files, mirrorBody.manifest) && catalogHash(mirrorBody.manifest) === publisherCatalogHash;
    if (!ok) throw new Error('镜像取回目录校验失败');
    writeArtifact('04-catalog-from-mirror.json', mirror.text);
    log('步骤5', `买方从镜像下载发布站目录：manifest 校验通过，catalog_hash 一致`);
  })(), STEP_TIMEOUT_MS, '步骤5 标签检索 + 买方下载');

  // =====================================================================
  // 步骤 6 — 签 DEAL + 双方回执，POST 索引站
  // =====================================================================
  let dealObjectId;
  let dealBodyHash;
  let settlementEventId;
  let buyerReceiptObjectId;
  let sellerReceiptObjectId;
  await withTimeout((async () => {
    stepBanner(6, '签 DEAL + 双方回执并提交索引站');

    const dealBody = {
      trade_id: TRADE_ID,
      buyer: BUYER,
      seller: SELLER,
      subject: {
        listing_ref: publisherObjectId,
        description: '朝阳区家电维修上门服务（虚构演示数据）',
        quantity: 1,
        acceptance_conditions: ['上门前电话确认故障', '维修后提供 30 天保修（虚构）'],
      },
      settlement: {
        asset: 'iso4217:CNY',
        amount: '150.00',
        method: 'manual-settlement',
        executor_ref: 'demo_finance',
      },
      fulfillment: {
        deadline: '2026-12-31T00:00:00Z',
        destination_ref: '朝阳区某小区（虚构）',
        carrier_ref: 'demo-carrier',
      },
    };
    const dealBuyerSigned = addSignature(buildObject('DEAL', dealBody), BUYER, buyerSeed, T_DEAL_BUYER);
    const deal = addSignature(dealBuyerSigned, SELLER, sellerSeed, T_DEAL_SELLER);
    dealObjectId = objectId(deal);
    dealBodyHash = deal.body_hash;
    writeArtifact('06-deal.signed.json', serialize(deal));
    log('步骤6', `双签 DEAL object_id=${dealObjectId}（buyer+seller 双签名）`);

    const settlementEvent = addSignature(
      buildObject('TRADE_EVENT', {
        event_id: 'evt-s5-settlement-0001',
        trade_id: TRADE_ID,
        event_type: 'PAYMENT_CONFIRMED',
        actor: SELLER,
        occurred_at: T_SETTLE,
        evidence: { method: 'manual-settlement', attested_by: 'demo_finance' },
        message: '虚构收款确认 150.00 CNY',
      }),
      SELLER,
      sellerSeed,
      T_SETTLE,
    );
    settlementEventId = objectId(settlementEvent);
    writeArtifact('07-payment-confirmed.signed.json', serialize(settlementEvent));

    const receiptCommon = {
      trade_id: TRADE_ID,
      contract_hash: dealObjectId,
      evidence: {
        deal_ref: { object_id: dealObjectId, body_hash: dealBodyHash },
        settlement_event_ref: settlementEventId,
        bundle: [deal],
      },
    };
    const buyerReceipt = addSignature(
      buildObject('TRADE_RECEIPT', {
        ...receiptCommon,
        receipt_id: 'receipt-s5-0001-buyer-to-seller',
        subject: SELLER,
        direction: 'buyer_to_seller',
        result: 'COMPLETED',
        rating: 'POSITIVE',
        comment: '家电维修上门服务符合约定（虚构）',
        metrics: { specification_match: true, delivery_hours: 24, communication_score: 5, overall_score: 5 },
        transaction_summary: { category: 'home-appliance-repair', asset: 'iso4217:CNY', amount_disclosure: 'exact', amount_range: ['150.00', '150.00'] },
      }),
      BUYER,
      buyerSeed,
      T_RCPT_BUYER,
    );
    const sellerReceipt = addSignature(
      buildObject('TRADE_RECEIPT', {
        ...receiptCommon,
        receipt_id: 'receipt-s5-0002-seller-to-buyer',
        subject: BUYER,
        direction: 'seller_to_buyer',
        result: 'COMPLETED',
        rating: 'POSITIVE',
        comment: '买方按时付款（虚构）',
        metrics: { specification_match: true, delivery_hours: 24, communication_score: 5, overall_score: 5 },
        transaction_summary: { category: 'home-appliance-repair', asset: 'iso4217:CNY', amount_disclosure: 'exact', amount_range: ['150.00', '150.00'] },
      }),
      SELLER,
      sellerSeed,
      T_RCPT_SELLER,
    );
    buyerReceiptObjectId = objectId(buyerReceipt);
    sellerReceiptObjectId = objectId(sellerReceipt);
    writeArtifact('10-receipt-buyer.signed.json', serialize(buyerReceipt));
    writeArtifact('10-receipt-seller.signed.json', serialize(sellerReceipt));
    log('步骤6', `买方回执 object_id=${buyerReceiptObjectId}（subject=${SELLER}）`);
    log('步骤6', `卖方回执 object_id=${sellerReceiptObjectId}（subject=${BUYER}）`);

    const submit = async (receipt) => {
      const res = await httpJson(INDEXER_BASE, '/receipts', { method: 'POST', body: serialize(receipt) });
      return { status: res.status, json: res.json };
    };
    const buyerSub = await submit(buyerReceipt);
    const sellerSub = await submit(sellerReceipt);
    for (const [label, r] of [
      ['买方回执→indexer', buyerSub],
      ['卖方回执→indexer', sellerSub],
    ]) {
      log('步骤6', `${label}：HTTP ${r.status} status=${r.json?.status ?? '?'} score=${r.json?.receipt?.score ?? '-'}`);
      if (r.status !== 201 && r.status !== 200) throw new Error(`${label} 收录失败：${JSON.stringify(r.json)}`);
    }
  })(), STEP_TIMEOUT_MS, '步骤6 签 DEAL + 回执提交');

  // =====================================================================
  // 步骤 7 — 快照导出 + 杀 indexer + 离线查询
  // =====================================================================
  let snapshotPath;
  let sigPath;
  let offlineQuery;
  await withTimeout((async () => {
    stepBanner(7, 'GET /export 快照 → 杀 indexer → 离线 CLI 查询');

    const exp = await httpJson(INDEXER_BASE, '/export');
    if (exp.status !== 200) throw new Error(`/export 失败 status=${exp.status}`);
    snapshotPath = join(EXPORT_DIR, 'indexer.json');
    sigPath = join(EXPORT_DIR, 'indexer.sig');
    writeFileSync(snapshotPath, JSON.stringify(exp.json.snapshot, null, 2) + '\n', 'utf8');
    writeFileSync(sigPath, JSON.stringify(exp.json.signature, null, 2) + '\n', 'utf8');
    log('步骤7', `快照导出：subjects=${exp.json.snapshot.body.subjects.map((s) => `${s.agent_id}=${s.score}`).join('，')}`);

    // 杀 indexer 进程。
    await stopProcess(roleProcs.indexer, 'indexer');

    // demo-indexer CLI 离线查询（无服务器，验签 + 回答 subject 评分）。
    const q = await runCli([
      DEMO_INDEXER_CLI,
      'query',
      snapshotPath,
      '--subject',
      SELLER,
      '--sig',
      sigPath,
    ]);
    let parsedQ = null;
    try {
      parsedQ = JSON.parse(q.stdout);
    } catch {
      /* 非 JSON */
    }
    offlineQuery = { exit: q.exitCode, stdout: q.stdout, stderr: q.stderr, verified: parsedQ?.verified, score: parsedQ?.score, receipt_count: parsedQ?.receipt_count };
    log('步骤7', `离线查询（subject=${SELLER}）：exit=${q.exitCode} verified=${parsedQ?.verified} score=${parsedQ?.score}`);
    if (q.exitCode !== 0 || parsedQ?.verified !== 'valid') {
      throw new Error(`离线查询失败：exit=${q.exitCode} stderr=${q.stderr} stdout=${q.stdout}`);
    }
  })(), STEP_TIMEOUT_MS, '步骤7 快照导出 + 离线查询');

  // =====================================================================
  // 步骤 8 — 重启 indexer → 杀 publisher → 镜像仍可供目录
  // =====================================================================
  let mirrorAfterPublisherDeath;
  await withTimeout((async () => {
    stepBanner(8, '重启 indexer → 杀 publisher → 镜像仍可供目录');

    // 重启 indexer（同 data_dir，验证镜像/回执持久化）。
    startRole('indexer', 'configs/indexer.yaml');
    await waitHealthy(INDEXER_BASE, 'indexer(重启)');
    log('步骤8', 'indexer 已重启（同 data_dir，镜像持久化）');

    // 杀 publisher 进程。
    await stopProcess(roleProcs.publisher, 'publisher');

    // indexer 镜像仍可供目录（发布站已死，但其目录内容仍在 indexer 镜像）。
    const mirror = await httpJson(INDEXER_BASE, `/catalogs/${publisherCatalogHash}`);
    const files = mirror.status === 200
      ? JSON.parse(mirror.text).files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }))
      : [];
    const manifest = mirror.status === 200 ? JSON.parse(mirror.text).manifest : undefined;
    const ok = mirror.status === 200 && manifest !== undefined && verifyCatalogFiles(files, manifest) && catalogHash(manifest) === publisherCatalogHash;
    mirrorAfterPublisherDeath = { status: mirror.status, ok };
    log('步骤8', `杀 publisher 后 indexer 镜像取回：status=${mirror.status} 校验=${ok}`);
    if (!ok) throw new Error('杀 publisher 后 indexer 镜像仍可供目录断言失败');
  })(), STEP_TIMEOUT_MS, '步骤8 镜像持久化断言');

  // ---------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------
  summary.steps['1'] = { indexer: INDEXER_BASE, publisher: PUBLISHER_BASE, integrator: INTEGRATOR_BASE };
  summary.steps['2'] = { publisher_object_id: publisherObjectId, publisher_catalog_hash: publisherCatalogHash, listing_file: 'runlog/artifacts/01-listing-publisher.signed.json' };
  summary.steps['3'] = { integrator_object_id: integratorObjectId, topic_catalog_hash: topicCatalogHash, theme: '北京家电维修专题', listing_file: 'runlog/artifacts/02-listing-integrator.signed.json' };
  summary.steps['4'] = { publisher_catalog_hash: publisherCatalogHash, topic_catalog_hash: topicCatalogHash };
  summary.steps['5'] = {
    search_chaoyang_hits: searchChaoyang.json?.catalogs ?? [],
    search_beijing_hits: searchBeijing.json?.catalogs ?? [],
    mirror_file: 'runlog/artifacts/04-catalog-from-mirror.json',
  };
  summary.steps['6'] = {
    deal_object_id: dealObjectId,
    deal_body_hash: dealBodyHash,
    settlement_event_object_id: settlementEventId,
    buyer_receipt_object_id: buyerReceiptObjectId,
    seller_receipt_object_id: sellerReceiptObjectId,
    deal_file: 'runlog/artifacts/06-deal.signed.json',
    settlement_event_file: 'runlog/artifacts/07-payment-confirmed.signed.json',
    buyer_receipt_file: 'runlog/artifacts/10-receipt-buyer.signed.json',
    seller_receipt_file: 'runlog/artifacts/10-receipt-seller.signed.json',
  };
  summary.steps['7'] = { snapshot_file: 'runlog/export/indexer.json', sig_file: 'runlog/export/indexer.sig', offline_query: offlineQuery };
  summary.steps['8'] = { mirror_after_publisher_death: mirrorAfterPublisherDeath };
  summary.flags.publisher_killed = true;
  summary.flags.indexer_mirror_serves_after_publisher_death = mirrorAfterPublisherDeath.ok;

  writeFileSync(join(RUN, 'demo-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  writeFileSync(join(RUN, 'demo.log'), logLines.join('\n') + '\n', 'utf8');
  log('done', `完成。摘要：runlog/demo-summary.json`);
  log('done', '下一步：node assertions.mjs');
}

// ---------------------------------------------------------------------------
// 全局看门狗 + 入口
// ---------------------------------------------------------------------------

const GLOBAL_WATCHDOG_MS = 240_000;
const watchdog = setTimeout(() => {
  console.error(`❌ 全局看门狗：脚本超过 ${GLOBAL_WATCHDOG_MS / 1000}s 仍未结束，强制退出`);
  process.exit(1);
}, GLOBAL_WATCHDOG_MS);
watchdog.unref();

main()
  .catch((err) => {
    console.error(`\n❌ demo.mjs 失败：${err instanceof Error ? err.message : String(err)}`);
    if (err && err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupAll();
    try {
      writeFileSync(join(RUN, 'demo.log'), logLines.join('\n') + '\n', 'utf8');
    } catch {
      /* runlog 可能尚未创建 */
    }
  });
