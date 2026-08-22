/**
 * demo.mjs — M11 棉花娃娃端到端演示（11 步驱动）。
 *
 * 走通协议文档 §9E 的 11 步，全部使用已交付模块：
 *   包：identity / signed-files / local-store / bt-catalog（M1–M4）
 *   适配器：email（M5，loopback 或 GreenMail）、settlement（M6）、
 *           human-task（M7）
 *   应用：demo-indexer（M8，双实例双权重）、mcp-server（M9，stdio，经
 *          @modelcontextprotocol/client 驱动）
 *
 * 模式：
 *   RUN_MODE=loopback（默认，无 Docker）：M5 邮件用 deps 注入共享内存信箱；
 *   RUN_MODE=greenmail（需 Docker）：走 adapters/email 的 GreenMail 容器。
 *
 * 端口固定（可经环境变量覆盖，保证 object_id 可复现）：
 *   TRACKER_PORT=16881  INDEXER_A_PORT=18781  INDEXER_B_PORT=18782
 *
 * 产物：runlog/artifacts/（各步签名文件）、runlog/export/（静态快照）、
 *       runlog/demo-summary.json（断言与 README 引用的权威摘要）。
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
import { openStore } from '@agent-trade/local-store';
import { buildManifest, catalogHash, startTracker, verifyCatalogFiles } from '@agent-trade/bt-catalog';
import { createMailAdapter } from '@agent-trade/email';
import { createManualSettlementAdapter } from '@agent-trade/settlement';
import { createHumanTaskStore } from '@agent-trade/human-task';
import { Indexer, loadWeights } from '@agent-trade/demo-indexer';
import { startIndexerServer } from '@agent-trade/demo-indexer';

import { SharedMailboxes, LoopbackSource, LoopbackTransport } from './lib/loopback-mail.mjs';
import { MCPHandle } from './lib/mcp.mjs';
import { seedBounded, downloadBounded } from './lib/bt-bounded.mjs';

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const ROOT = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(ROOT, '..', '..', 'protocol', 'test-vectors', 'vectors.json');
const CLI_PATH = join(ROOT, '..', '..', 'apps', 'demo-indexer', 'dist', 'cli.js');
const WEIGHTS_A = join(ROOT, '..', '..', 'apps', 'demo-indexer', 'weights.json');
const WEIGHTS_B = join(ROOT, '..', '..', 'apps', 'demo-indexer', 'weights-alt.json');

const RUN_MODE = process.env.RUN_MODE ?? 'loopback';
const TRACKER_PORT = Number(process.env.TRACKER_PORT ?? 16881);
const INDEXER_A_PORT = Number(process.env.INDEXER_A_PORT ?? 18781);
const INDEXER_B_PORT = Number(process.env.INDEXER_B_PORT ?? 18782);

const BUYER = 'agent_buyer';
const SELLER = 'agent_seller';
const INTEGRATOR = 'agent_integrator';

const BUYER_ADDR = 'buyer@momo.example';
const SELLER_ADDR = 'seller@doll-studio.example';
const INTEGRATOR_ADDR = 'integrator@spring-theme.example';

/** 固定 trade_id（uuid v7，规范 §4）：买方起草时生成；此处固定以便复现。 */
const TRADE_ID = '018e2c20-0000-7000-8000-000000000001';

/** 演示专用虚构身份（非真实秘密；仅用于整合商角色，固定以便复现）。 */
const INTEGRATOR_SEED = 'Y_8Fq-yMB8zfF0kuIX6_CEq49gAv27xk38uqd0jqJ1I';

/** 权威向量身份种子（main 内从 vectors.json 读取后赋值）。 */
let buyerSeed;
let sellerSeed;

const RUN = join(ROOT, 'runlog');
const ART = join(RUN, 'artifacts');
const EXPORT_DIR = join(RUN, 'export');
const BUYER_DIR = join(RUN, 'buyer');
const SELLER_DIR = join(RUN, 'seller');
const INTEGRATOR_DIR = join(RUN, 'integrator');
const INDEXER_A_DIR = join(RUN, 'indexer-a');
const INDEXER_B_DIR = join(RUN, 'indexer-b');
const SELLER_CATALOG_DIR = join(ROOT, 'seller', 'catalog');
const THEMED_DIR = join(RUN, 'themed');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const log = (step, msg) => {
  const line = `[${step}] ${msg}`;
  console.log(line);
  logLines.push(line);
};
const logLines = [];

const stepBanner = (n, title) => log(`步骤${n}`, `==== ${title} ====`);

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

function writeArtifact(name, text) {
  const p = join(ART, name);
  writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n', 'utf8');
  return p;
}

/** 签发一个对象并返回 SignedFile。issuedAt 固定保证对象可复现。 */
function signed(objectType, body, signer, secretKey, issuedAt) {
  return addSignature(buildObject(objectType, body), signer, secretKey, issuedAt);
}

function openKeyringStore(dir) {
  const store = openStore(dir);
  store.saveKey(BUYER, buyerSeed);
  store.saveKey(SELLER, sellerSeed);
  store.saveKey(INTEGRATOR, INTEGRATOR_SEED);
  store.close();
}

async function withStore(dir, fn) {
  const store = openStore(dir);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** 目录文件 → canonical manifest + catalog_hash（torrent 路径带目录前缀）。 */
function manifestOf(files, dirPrefix) {
  const manifest = buildManifest(files.map((f) => ({ path: `${dirPrefix}/${f.path}`, data: f.data })));
  return { manifest, hash: catalogHash(manifest) };
}

/** 目录 → 检索站存档包原始体（{ manifest, files: [{path, content(base64)}] }）。 */
function catalogArchiveBody(files, dirPrefix) {
  const { manifest, hash } = manifestOf(files, dirPrefix);
  const body = {
    manifest,
    files: files.map((f) => ({ path: `${dirPrefix}/${f.path}`, content: Buffer.from(f.data).toString('base64') })),
  };
  return { rawBody: JSON.stringify(body), manifest, hash };
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    const e = err;
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function httpJson(base, path, init) {
  const res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, text, json };
}

// ---------------------------------------------------------------------------
// 超时兜底（集成层硬约束：任何一步/任一 I/O 都不得无限挂起）
// ---------------------------------------------------------------------------

const STEP_TIMEOUT_MS = 30_000; // 步骤级硬超时
/** BT_MODE=mirror 强制降级镜像（测试/验证 fallback 路径用）；默认 bt。 */
const BT_MODE = process.env.BT_MODE ?? 'bt';
const BT_TIMEOUT_MS = 20_000; // BT 播种/下载单独超时（超时即销毁客户端）
const HTTP_TIMEOUT_MS = 15_000; // 索引器 HTTP 调用超时

/** 给任意 Promise 加硬超时：超时抛带标签的错误（绝不静默挂起）。 */
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

/**
 * 从检索站镜像取回目录。返回 { ok, raw }，ok = manifest 逐文件校验通过
 * 且 catalog_hash 一致 —— BT 下载失败/超时时的降级路径（[fallback] http-mirror）。
 */
async function fetchCatalogMirror(base, hash) {
  const res = await httpJson(base, `/catalogs/${hash}`);
  if (res.status !== 200) return { ok: false, raw: undefined };
  const body = JSON.parse(res.text);
  const files = body.files.map((f) => ({ path: f.path, data: Uint8Array.from(Buffer.from(f.content, 'base64')) }));
  const ok = verifyCatalogFiles(files, body.manifest) && catalogHash(body.manifest) === hash;
  return { ok, raw: res.text };
}

// ---------------------------------------------------------------------------
// 邮件通道（M5）：loopback 或 GreenMail
// ---------------------------------------------------------------------------

const sharedMail = new SharedMailboxes();

function makeMailAdapters() {
  const mk = (user, address) => {
    const base = {
      smtpUrl: `smtp://${user}@${address.split('@')[1]}:587`,
      imapUrl: `imap://${user}@${address.split('@')[1]}:143`,
      inboxDir: join(RUN, 'mail', user, 'inbox'),
      seenStorePath: join(RUN, 'mail', user, 'seen.json'),
    };
    if (RUN_MODE === 'greenmail') {
      // 需 Docker（adapters/email/docker-compose.greenmail.yml）。
      const gm = process.env.GREENMAIL_BASE ?? '127.0.0.1';
      const smtpPort = process.env.GREENMAIL_SMTP_PORT ?? '3025';
      const imapPort = process.env.GREENMAIL_IMAP_PORT ?? '3143';
      return createMailAdapter({
        smtpUrl: `smtp://${user}:${user}-pass@${gm}:${smtpPort}`,
        imapUrl: `imap://${user}:${user}-pass@${gm}:${imapPort}`,
        inboxDir: base.inboxDir,
        seenStorePath: base.seenStorePath,
      });
    }
    return createMailAdapter(base, {
      source: new LoopbackSource(sharedMail, address),
      transport: new LoopbackTransport(sharedMail, address),
      warn: (m) => log('mail', `warn: ${m}`),
    });
  };
  return {
    buyer: mk('buyer', BUYER_ADDR),
    seller: mk('seller', SELLER_ADDR),
    integrator: mk('integrator', INTEGRATOR_ADDR),
  };
}

async function sendObj(adapter, to, subject, obj, filename, tradeId) {
  const bytes = new TextEncoder().encode(serialize(obj));
  await adapter.send({ to, tradeId, subject, attachments: [{ filename, data: bytes }] });
  log('mail', `-> ${to} 主题="${subject}" 附件=${filename}`);
}

async function sendText(adapter, to, subject, text, tradeId) {
  await adapter.send({ to, tradeId, subject, text });
  log('mail', `-> ${to} 主题="${subject}"（文本）`);
}

/** 轮询收件箱，返回本次投递的全部消息（含已落盘附件路径）。InboundMsg 无 subject 字段。 */
async function poll(adapter, who) {
  const msgs = await adapter.poll();
  if (msgs.length === 0) log('mail', `${who} 轮询：无新邮件`);
  for (const m of msgs) {
    const text = m.text ? m.text.slice(0, 40).replace(/\n/g, ' ') : '';
    log('mail', `${who} 收到 X-Trade-Id="${m.tradeId}" 附件=[${m.attachments.map((a) => a.filename).join(', ')}] 正文="${text}"`);
  }
  return msgs;
}

/** 从一次轮询结果里取出第一个匹配前缀的附件文本。 */
function attachmentText(msgs, prefix) {
  for (const m of msgs) {
    for (const a of m.attachments) {
      if (a.filename.startsWith(prefix)) return readFileSync(a.path, 'utf8');
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const summary = {
  mode: RUN_MODE,
  trade_id: TRADE_ID,
  ports: { tracker: TRACKER_PORT, indexer_a: INDEXER_A_PORT, indexer_b: INDEXER_B_PORT },
  mail_trace: sharedMail.trace,
  steps: {},
  flags: {},
};

/** 清理句柄，保证中途失败也能释放端口/进程。 */
const cleanup = [];
const cleanupAll = async () => {
  for (const fn of [...cleanup].reverse()) {
    try {
      await fn();
    } catch {
      /* 尽力而为 */
    }
  }
};

async function main() {
  log('init', `M11 棉花娃娃端到端演示 · mode=${RUN_MODE}`);
  for (const d of [RUN, ART, EXPORT_DIR, BUYER_DIR, SELLER_DIR, INTEGRATOR_DIR, INDEXER_A_DIR, INDEXER_B_DIR, THEMED_DIR]) {
    mkdirSync(d, { recursive: true });
  }

  // 身份：buyer/seller 种子取自协议权威测试向量；integrator 为演示固定种子。
  const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  buyerSeed = vectors.identities.agent_buyer.seed;
  sellerSeed = vectors.identities.agent_seller.seed;
  const KEYS = new Map([
    [BUYER, buyerSeed],
    [SELLER, sellerSeed],
    [INTEGRATOR, INTEGRATOR_SEED],
  ]);
  const resolveKey = (signer) => {
    const k = KEYS.get(signer);
    return k === undefined ? undefined : publicKeyFromSeed(k);
  };

  // 各参与方 store 预置信任环（saveKey 注册后 putObject/applyEvent 才能验签）。
  for (const dir of [BUYER_DIR, SELLER_DIR, INTEGRATOR_DIR]) openKeyringStore(dir);

  // 跨步骤共享变量：步骤级超时包装把每步包成 IIFE，跨步骤使用的变量提升到
  // main 作用域（在步骤内改为赋值）。
  let tracker;
  let announce, sellerFiles, sellerCatalog, sellerCatalogHash, sellerSeeder, sellerMagnet, sellerListingId;
  let themedFiles, themedCatalog, themedSeeder, themedMagnet;
  let indexerA, indexerB, serverA, serverB, baseA, baseB;
  let dealObjectId;
  let buyerStore, sellerStore, buyerTasks, paymentConfirmedId, receiveId;
  let finalBuyerState, finalSellerState;

  const mail = makeMailAdapters();
  cleanup.push(async () => {
    await Promise.all([mail.buyer.close(), mail.seller.close(), mail.integrator.close()]);
  });

  // =====================================================================
  // 步骤 1 — 卖方发布目录
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(1, '卖方发布目录（bt-catalog 播种 + LISTING_REF 签发 + 邮件通告整合商）');

  tracker = await startTracker(TRACKER_PORT);
  cleanup.push(() => tracker.close());
  announce = `http://127.0.0.1:${tracker.port}/announce`;
  log('步骤1', `本地 tracker 就绪：${announce}`);

  sellerFiles = readDirFiles(SELLER_CATALOG_DIR);
  sellerCatalog = manifestOf(sellerFiles, 'catalog');
  sellerCatalogHash = sellerCatalog.hash;
  log('步骤1', `卖方目录 manifest：${sellerCatalog.manifest.files.length} 个文件，catalog_hash=${sellerCatalogHash}`);

  sellerSeeder = await seedBounded(SELLER_CATALOG_DIR, { tracker: [announce], dht: false }, BT_TIMEOUT_MS);
  cleanup.push(() => sellerSeeder.stop());
  sellerMagnet = sellerSeeder.magnetURI;
  log('步骤1', `卖方已播种 magnet=${sellerMagnet.slice(0, 90)}…`);

  const listingBody = {
    publisher: SELLER,
    catalog_id: 'cotton-doll-catalog-2026',
    catalog_hash: sellerCatalogHash,
    item_id: 'cotton-doll-deluxe-set',
    item_revision: 1,
    distribution_refs: [
      { type: 'magnet', uri: sellerMagnet },
      { type: 'email', uri: `mailto:${SELLER_ADDR}` },
    ],
  };
  const sellerListing = signed('LISTING_REF', listingBody, SELLER, sellerSeed, '2026-08-20T00:00:00Z');
  sellerListingId = objectId(sellerListing);
  const listingFile = writeArtifact('01-listing-seller.signed.json', serialize(sellerListing));
  await withStore(SELLER_DIR, (store) => store.putObject(sellerListing));
  log('步骤1', `LISTING_REF object_id=${sellerListingId}`);

  await sendObj(mail.seller, INTEGRATOR_ADDR, '[catalog] cotton-doll-catalog-2026 已发布', sellerListing, '01-listing-seller.signed.json', 'cotton-doll-catalog-2026');

  summary.steps['1'] = {
    listing_object_id: sellerListingId,
    listing_file: listingFile,
    catalog_hash: sellerCatalogHash,
    magnet: sellerMagnet,
    manifest_files: sellerCatalog.manifest.files.length,
  };

  })(), STEP_TIMEOUT_MS, '步骤1 卖方发布目录');

  // =====================================================================
  // 步骤 2 — 整合商专题目录
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(2, '整合商专题目录（整合商收通告 → 建专题目录 → 签发 LISTING_REF → 邮件通告买方）');

  const intgMsgs = await poll(mail.integrator, '整合商');
  const intgListingText = attachmentText(intgMsgs, '01-listing-seller.signed.json');
  if (intgListingText === undefined) throw new Error('整合商未收到卖方 LISTING_REF 邮件');
  const sellerListingCopy = parse(intgListingText);
  await withStore(INTEGRATOR_DIR, (store) => store.putObject(sellerListingCopy));
  log('步骤2', `整合商已收录卖方 LISTING_REF（object_id=${objectId(sellerListingCopy)}）`);

  // 专题目录内容（虚构）：精选卖家的豪华套装。
  const themeJson = {
    theme: 'spring-2026',
    title: '2026 春季棉花娃娃专题',
    curator: INTEGRATOR,
    featured_item_id: 'cotton-doll-deluxe-set',
    source_catalog_hash: sellerCatalogHash,
    source_listing_ref: sellerListingId,
    items: [
      {
        item_id: 'cotton-doll-deluxe-set',
        source: 'cotton-doll-catalog-2026',
        note: '限定款：25cm 心跳棉 + 礼服 B + 换装 C + 配件包',
      },
    ],
    note: '虚构专题目录，演示数据',
  };
  writeFileSync(join(THEMED_DIR, 'theme-2026-spring.json'), JSON.stringify(themeJson, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(THEMED_DIR, 'theme-notes.md'),
    '# 2026 春季棉花娃娃专题（整合商 curated）\n\n- curator: agent_integrator\n- 精选卖家的 `cotton-doll-deluxe-set`（限定款）\n- 全部虚构\n',
    'utf8',
  );

  themedFiles = readDirFiles(THEMED_DIR);
  themedCatalog = manifestOf(themedFiles, 'themed');
  themedSeeder = await seedBounded(THEMED_DIR, { tracker: [announce], dht: false }, BT_TIMEOUT_MS);
  cleanup.push(() => themedSeeder.stop());
  themedMagnet = themedSeeder.magnetURI;

  const themeListing = signed(
    'LISTING_REF',
    {
      publisher: INTEGRATOR,
      catalog_id: 'spring-2026-theme',
      catalog_hash: themedCatalog.hash,
      item_id: 'spring-2026-theme',
      item_revision: 1,
      distribution_refs: [
        { type: 'magnet', uri: themedMagnet },
        { type: 'email', uri: `mailto:${INTEGRATOR_ADDR}` },
      ],
    },
    INTEGRATOR,
    INTEGRATOR_SEED,
    '2026-08-20T00:00:01Z',
  );
  const themeListingId = objectId(themeListing);
  const themeListingFile = writeArtifact('02-listing-integrator.signed.json', serialize(themeListing));
  await withStore(INTEGRATOR_DIR, (store) => store.putObject(themeListing));
  log('步骤2', `整合商专题 LISTING_REF object_id=${themeListingId}`);

  await sendObj(
    mail.integrator,
    BUYER_ADDR,
    '[theme] 2026 春季棉花娃娃专题（含卖方目录引用）',
    themeListing,
    '02-listing-integrator.signed.json',
    'spring-2026-theme',
  );
  await sendObj(
    mail.integrator,
    BUYER_ADDR,
    '[theme] 附：卖方棉花娃娃目录 LISTING_REF',
    sellerListingCopy,
    '01-listing-seller.signed.json',
    'spring-2026-theme',
  );

  summary.steps['2'] = {
    listing_object_id: themeListingId,
    listing_file: themeListingFile,
    catalog_hash: themedCatalog.hash,
    magnet: themedMagnet,
    manifest_files: themedCatalog.manifest.files.length,
    seller_listing_object_id: sellerListingId,
  };

  })(), STEP_TIMEOUT_MS, '步骤2 整合商专题目录');

  // =====================================================================
  // 步骤 3 — 检索站收录 + 卖方/tracker 下线 + 镜像验证
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(3, '检索站收录（双索引器启动 → 目录 HTTP 镜像存档 → 买方 BT 下载 → 卖方与 tracker 下线 → 镜像取回）');

  indexerA = new Indexer({ dir: INDEXER_A_DIR, weights: loadWeights(WEIGHTS_A), indexerId: 'indexer-a' });
  indexerB = new Indexer({ dir: INDEXER_B_DIR, weights: loadWeights(WEIGHTS_B), indexerId: 'integrator-b' });
  for (const ix of [indexerA, indexerB]) {
    ix.addTrusted(BUYER, buyerSeed);
    ix.addTrusted(SELLER, sellerSeed);
    ix.addTrusted(INTEGRATOR, INTEGRATOR_SEED);
  }
  serverA = await startIndexerServer(indexerA, INDEXER_A_PORT);
  serverB = await startIndexerServer(indexerB, INDEXER_B_PORT);
  cleanup.push(async () => {
    await Promise.all([serverA.close(), serverB.close()]);
    indexerA.close();
    indexerB.close();
  });
  baseA = `http://127.0.0.1:${serverA.port}`;
  baseB = `http://127.0.0.1:${serverB.port}`;
  log('步骤3', `索引器 A（检索站 indexer-a, weights.json）: ${baseA}`);
  log('步骤3', `索引器 B（整合商 integrator-b, weights-alt.json）: ${baseB}`);

  // 卖方目录 + 整合商专题目录 → 检索站 HTTP 镜像存档。
  const sellerArchive = catalogArchiveBody(sellerFiles, 'catalog');
  const putA = await httpJson(baseA, `/catalogs/${sellerCatalogHash}`, { method: 'PUT', body: sellerArchive.rawBody });
  if (putA.status !== 201) throw new Error(`目录存档失败 status=${putA.status} body=${putA.text}`);
  const sellerArchiveFile = writeArtifact('03-catalog-archive-seller.json', sellerArchive.rawBody);

  const themedArchive = catalogArchiveBody(themedFiles, 'themed');
  const putTheme = await httpJson(baseA, `/catalogs/${themedCatalog.hash}`, { method: 'PUT', body: themedArchive.rawBody });
  if (putTheme.status !== 201) throw new Error(`专题目录存档失败 status=${putTheme.status} body=${putTheme.text}`);
  const themedArchiveFile = writeArtifact('03-catalog-archive-themed.json', themedArchive.rawBody);
  log('步骤3', `检索站已存档两份目录（HTTP 镜像）`);

  // 买方趁 tracker 在线时先经 BT 拿到两份目录（验证 M4 闭环）；
  // BT 超时（20s）/失败时降级到检索站 HTTP 镜像（[fallback] http-mirror），
  // 断言任一路径取得的目录内容哈希 === catalog_hash。
  const themeDlDir = join(RUN, 'buyer', 'dl-theme');
  let themeDlPath = 'bt';
  let themeDlOk = false;
  if (BT_MODE === 'mirror') {
    themeDlPath = 'http-mirror';
    log('步骤3', '[fallback] http-mirror BT_MODE=mirror 强制走镜像（验证降级路径）');
    const fb = await fetchCatalogMirror(baseA, themedCatalog.hash);
    themeDlOk = fb.ok;
    if (fb.ok) writeArtifact('05-catalog-theme-from-mirror.json', fb.raw);
  } else {
    try {
      const themedDlManifest = await downloadBounded(themedMagnet, themeDlDir, { tracker: [announce], dht: false }, BT_TIMEOUT_MS);
      themeDlOk = catalogHash(themedDlManifest) === themedCatalog.hash;
      log('步骤3', `买方 BT 下载专题目录：${themedDlManifest.files.length} 个文件，catalog_hash 一致=${themeDlOk}`);
    } catch (btErr) {
      themeDlPath = 'http-mirror';
      log('步骤3', `[fallback] http-mirror BT 下载专题目录失败/超时（${btErr.message}），改经检索站镜像取回`);
      const fb = await fetchCatalogMirror(baseA, themedCatalog.hash);
      themeDlOk = fb.ok;
      if (fb.ok) writeArtifact('05-catalog-theme-from-mirror.json', fb.raw);
    }
  }

  const sellerDlDir = join(RUN, 'buyer', 'dl-seller');
  let sellerDlPath = 'bt';
  let sellerDlOk = false;
  if (BT_MODE === 'mirror') {
    sellerDlPath = 'http-mirror';
    log('步骤3', '[fallback] http-mirror BT_MODE=mirror 强制走镜像（验证降级路径）');
    const fb = await fetchCatalogMirror(baseA, sellerCatalogHash);
    sellerDlOk = fb.ok;
    if (fb.ok) writeArtifact('05-catalog-seller-from-mirror.json', fb.raw);
  } else {
    try {
      const sellerDlManifest = await downloadBounded(sellerMagnet, sellerDlDir, { tracker: [announce], dht: false }, BT_TIMEOUT_MS);
      sellerDlOk = catalogHash(sellerDlManifest) === sellerCatalogHash;
      log('步骤3', `买方 BT 下载卖方目录：catalog_hash 一致=${sellerDlOk}`);
    } catch (btErr) {
      sellerDlPath = 'http-mirror';
      log('步骤3', `[fallback] http-mirror BT 下载卖方目录失败/超时（${btErr.message}），改经检索站镜像取回`);
      const fb = await fetchCatalogMirror(baseA, sellerCatalogHash);
      sellerDlOk = fb.ok;
      if (fb.ok) writeArtifact('05-catalog-seller-from-mirror.json', fb.raw);
    }
  }

  // 卖方与 tracker 中途下线（cleanup 保持幂等，重复清理被 try/catch 吸收）。
  await sellerSeeder.stop();
  await themedSeeder.stop();
  await tracker.close();
  log('步骤3', '卖方与 tracker 已下线（seed 停止、tracker 关闭）');

  // 买方经检索站 HTTP 镜像取得卖方目录（离线存档角色）。
  const mirror = await httpJson(baseA, `/catalogs/${sellerCatalogHash}`);
  if (mirror.status !== 200) throw new Error(`镜像取回失败 status=${mirror.status}`);
  const mirrorFile = writeArtifact('04-catalog-from-mirror.json', mirror.text);
  const mirrorBody = JSON.parse(mirror.text);
  const mirrorFiles = mirrorBody.files.map((f) => ({
    path: f.path,
    data: Uint8Array.from(Buffer.from(f.content, 'base64')),
  }));
  const mirrorVerifyOk = verifyCatalogFiles(mirrorFiles, mirrorBody.manifest) && catalogHash(mirrorBody.manifest) === sellerCatalogHash;
  log('步骤3', `镜像取回目录：manifest 校验=${mirrorVerifyOk}，catalog_hash 一致=${catalogHash(mirrorBody.manifest) === sellerCatalogHash}`);

  summary.steps['3'] = {
    archive_seller_file: sellerArchiveFile,
    archive_themed_file: themedArchiveFile,
    mirror_file: mirrorFile,
    seller_dl: { path: sellerDlPath, ok: sellerDlOk },
    theme_dl: { path: themeDlPath, ok: themeDlOk },
    mirror_verify_ok: mirrorVerifyOk,
  };
  summary.flags.seller_offline = true;
  summary.flags.tracker_offline = true;
  summary.flags.mirror_after_offline = true;

  })(), STEP_TIMEOUT_MS, '步骤3 检索站收录/下线/镜像');

  // =====================================================================
  // 步骤 4 — 买方找到并联系卖方
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(4, '买方找到并联系（收整合商通告 → 收录两份 LISTING_REF → 经镜像确认目录 → 邮件联系卖方）');

  const buyerMsgs = await poll(mail.buyer, '买方');
  const buyerThemeText = attachmentText(buyerMsgs, '02-listing-integrator.signed.json');
  const buyerSellerListingText = attachmentText(buyerMsgs, '01-listing-seller.signed.json');
  if (buyerThemeText === undefined || buyerSellerListingText === undefined) {
    throw new Error('买方未收到整合商通告（专题 + 卖方 LISTING_REF）');
  }
  const buyerThemeListing = parse(buyerThemeText);
  const buyerSellerListing = parse(buyerSellerListingText);
  await withStore(BUYER_DIR, (store) => {
    store.putObject(buyerThemeListing);
    store.putObject(buyerSellerListing);
  });
  log('步骤4', `买方已收录整合商专题（${objectId(buyerThemeListing)}）与卖方 LISTING_REF（${objectId(buyerSellerListing)}）`);

  // 从卖方 LISTING_REF 的 distribution_refs 提取联系方式。
  const emailUri = buyerSellerListing.body.distribution_refs.find((r) => r.type === 'email')?.uri ?? '';
  const sellerAddr = emailUri.replace(/^mailto:/, '');
  if (sellerAddr !== SELLER_ADDR) throw new Error(`卖方邮箱提取异常：${sellerAddr}`);
  log('步骤4', `买方从 LISTING_REF 提取卖方邮箱：${sellerAddr}`);

  const inquirySubject = '[trade] inquiry — cotton-doll-deluxe-set（含目录引用）';
  await sendText(
    mail.buyer,
    SELLER_ADDR,
    inquirySubject,
    `你好，我是 ${BUYER}（momo-collector）。\n` +
      `我从 2026 春季专题（${objectId(buyerThemeListing)}）了解到贵目录 ${sellerCatalogHash} 的 ` +
      `cotton-doll-deluxe-set（25cm 豪华套装）。\n` +
      `想买 1 套，预算 150.00 CNY 内。能否报价？`,
    TRADE_ID,
  );
  summary.steps['4'] = {
    buyer_contacted_seller: true,
    inquiry_subject: inquirySubject,
    seller_addr: sellerAddr,
    buyer_store_has_seller_listing: true,
  };

  })(), STEP_TIMEOUT_MS, '步骤4 买方找到并联系');

  // =====================================================================
  // 步骤 5 — 议价（邮件三封：报价 → 接受）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(5, '议价（邮件往来）');

  const sellerMsgs5 = await poll(mail.seller, '卖方');
  const quoteSubject = '[trade] quote — 128.00 CNY（cotton-doll-deluxe-set）';
  await sendText(
    mail.seller,
    BUYER_ADDR,
    quoteSubject,
    '你好，豪华套装目录价 128.00 CNY（含配件包），顺丰包邮，3 个工作日内发货。',
    TRADE_ID,
  );
  const buyerMsgs5 = await poll(mail.buyer, '买方');
  const acceptSubject = '[trade] accept — deal at 128.00 CNY';
  await sendText(
    mail.buyer,
    SELLER_ADDR,
    acceptSubject,
    '接受 128.00 CNY，含配件包，按目录规格交付。请出合同。',
    TRADE_ID,
  );
  const sellerMsgs5b = await poll(mail.seller, '卖方');

  const negotiation = sharedMail.trace
    .filter((m) => m.tradeId === TRADE_ID && m.subject.startsWith('[trade]'))
    .map((m) => ({ from: m.from, to: m.to, subject: m.subject }));
  log('步骤5', `议价往来 ${negotiation.length} 封：${negotiation.map((n) => n.subject).join(' | ')}`);
  summary.steps['5'] = { negotiation };

  })(), STEP_TIMEOUT_MS, '步骤5 议价');

  // =====================================================================
  // 步骤 6 — 双签合同（买方经 MCP 起草签署 → 邮件 → 卖方经 MCP 审签 + 记录 DEAL_SIGNED）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(6, '双签合同（MCP 起草/签署/审签 + 邮件传递 + 双方各自记录 DEAL_SIGNED）');

  const dealBody = {
    trade_id: TRADE_ID,
    buyer: BUYER,
    seller: SELLER,
    subject: {
      listing_ref: sellerListingId,
      description: '25cm 棉花娃娃豪华套装 ×1（含礼服 B、换装 C、配件包）',
      quantity: 1,
      acceptance_conditions: [
        '按目录规格交付（25cm 心跳棉 + 礼服 B + 换装 C + 配件包）',
        '外包装完好、无污损',
        '3 个工作日内发货',
      ],
    },
    settlement: { asset: 'iso4217:CNY', amount: '128.00', method: 'manual-settlement' },
    fulfillment: {
      deadline: '2026-10-31T00:00:00Z',
      destination_ref: 'momo-collector-warehouse',
      carrier_ref: 'demo-carrier',
    },
  };

  // 买方 MCP：compile（schema 校验 + body_hash）→ sign（本地私钥，红线）。
  const buyerMcp = await MCPHandle.start({ dir: BUYER_DIR, agentId: BUYER });
  cleanup.push(() => buyerMcp.close());
  const compiled = await buyerMcp.call('trade_compile_deal', { body: dealBody });
  if (compiled.isError) throw new Error(`trade_compile_deal 失败：${compiled.text}`);
  const draft = buildObject('DEAL', dealBody);
  const buyerSigned = await buyerMcp.call('trade_sign_deal', {
    deal: draft,
    expected_body_hash: compiled.data.body_hash,
    signer: BUYER,
  });
  if (buyerSigned.isError) throw new Error(`trade_sign_deal(买方) 失败：${buyerSigned.text}`);
  dealObjectId = buyerSigned.data.object_id;
  log('步骤6', `买方经 MCP 起草并签署 DEAL object_id=${dealObjectId}（body_hash=${compiled.data.body_hash}）`);
  await buyerMcp.close();

  const dealDraft = await withStore(BUYER_DIR, (store) => store.getObject(dealObjectId));
  if (dealDraft === undefined) throw new Error('买方 store 中找不到已签 DEAL');
  await sendObj(mail.buyer, SELLER_ADDR, '[trade] deal draft — 请审签', dealDraft, '05-deal-draft.signed.json', TRADE_ID);

  const sellerMsgs6 = await poll(mail.seller, '卖方');
  const draftText = attachmentText(sellerMsgs6, '05-deal-draft.signed.json');
  if (draftText === undefined) throw new Error('卖方未收到 DEAL 草案邮件');
  const dealDraftParsed = parse(draftText);

  // 卖方 MCP：审签同一文件（增签不破旧签）→ 记录 DEAL_SIGNED → 验证。
  const sellerMcp = await MCPHandle.start({ dir: SELLER_DIR, agentId: SELLER });
  cleanup.push(() => sellerMcp.close());
  const countersigned = await sellerMcp.call('trade_sign_deal', {
    deal: dealDraftParsed,
    expected_body_hash: dealDraftParsed.body_hash,
    signer: SELLER,
  });
  if (countersigned.isError) throw new Error(`trade_sign_deal(卖方) 失败：${countersigned.text}`);
  const sellerDealSigned = await sellerMcp.call('trade_record_event', {
    trade_id: TRADE_ID,
    event_type: 'DEAL_SIGNED',
    actor: SELLER,
    message: 'seller countersigned; deal effective',
  });
  if (sellerDealSigned.isError) throw new Error(`trade_record_event(DEAL_SIGNED) 失败：${sellerDealSigned.text}`);
  const sellerVerify = await sellerMcp.call('trade_verify_deal', { object_id: dealObjectId });
  if (sellerVerify.isError || sellerVerify.data.result !== 'valid') {
    throw new Error(`卖方 MCP 验证 DEAL 失败：${sellerVerify.text}`);
  }
  await sellerMcp.close();
  log('步骤6', `卖方经 MCP 审签成功（object_id=${countersigned.data.object_id}）并记录 DEAL_SIGNED → ${sellerDealSigned.data.state}`);

  const countersignedDeal = await withStore(SELLER_DIR, (store) => store.getObject(dealObjectId));
  if (countersignedDeal === undefined) throw new Error('卖方 store 中找不到双签 DEAL');
  const dealFile = writeArtifact('06-deal.signed.json', serialize(countersignedDeal));
  await sendObj(mail.seller, BUYER_ADDR, '[trade] deal countersigned', countersignedDeal, '06-deal-countersigned.signed.json', TRADE_ID);

  const buyerMsgs6 = await poll(mail.buyer, '买方');
  const countersignedText = attachmentText(buyerMsgs6, '06-deal-countersigned.signed.json');
  if (countersignedText === undefined) throw new Error('买方未收到双签 DEAL 邮件');
  const countersignedDeal2 = parse(countersignedText);

  // 买方记录 DEAL_SIGNED（同一合同，双方各自账本）。
  const buyerDealSignedEvent = signed(
    'TRADE_EVENT',
    {
      event_id: 'evt-0001-deal-signed-buyer',
      trade_id: TRADE_ID,
      event_type: 'DEAL_SIGNED',
      actor: BUYER,
      occurred_at: '2026-08-20T00:00:02Z',
      evidence: { contract: dealObjectId },
      message: 'buyer confirms dual-signed deal',
    },
    BUYER,
    buyerSeed,
    '2026-08-20T00:00:02Z',
  );
  const buyerState6 = await withStore(BUYER_DIR, (store) => {
    store.putObject(countersignedDeal2);
    return store.applyEvent(TRADE_ID, buyerDealSignedEvent);
  });
  const sellerState6 = sellerDealSigned.data.state;
  log('步骤6', `双签合同完成：买方账本=${buyerState6}，卖方账本=${sellerState6}`);

  summary.steps['6'] = {
    deal_object_id: dealObjectId,
    deal_file: dealFile,
    buyer_deal_signed_event: objectId(buyerDealSignedEvent),
    buyer_sig_count: countersignedDeal2.signatures.length,
    buyer_state: buyerState6,
    seller_state: sellerState6,
    seller_mcp_recorded_state: sellerState6,
    buyer_mcp_compile_ok: !compiled.isError,
    seller_deal_signed_event: sellerDealSigned.data.object_id,
  };

  })(), STEP_TIMEOUT_MS, '步骤6 双签合同');

  // =====================================================================
  // 步骤 7 — 钱包/人类支付（manual-settlement + M7 PAY 任务，演示自动标记完成）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(7, '钱包/人类支付（manual-settlement：PAY 任务 → 人工完成 → PAYMENT_CONFIRMED）');

  buyerStore = openStore(BUYER_DIR);
  sellerStore = openStore(SELLER_DIR);
  buyerTasks = createHumanTaskStore(buyerStore, { dir: BUYER_DIR });
  const manual = createManualSettlementAdapter({ taskStore: buyerTasks });

  const deal = buyerStore.getObject(dealObjectId);
  if (deal === undefined) throw new Error('买方 store 中找不到双签 DEAL（步骤7）');

  const paymentRequested = await manual.request(deal, { store: buyerStore, agentId: BUYER, secretKey: buyerSeed });
  const payTaskId = paymentRequested.body.evidence.task_id;
  const paymentRequestedId = objectId(paymentRequested);
  const prFile = writeArtifact('07-payment-requested.signed.json', serialize(paymentRequested));
  log('步骤7', `买方发起支付：PAYMENT_REQUESTED object_id=${paymentRequestedId}，任务 ${payTaskId}`);
  await sendObj(mail.buyer, SELLER_ADDR, '[trade] payment requested', paymentRequested, '07-payment-requested.signed.json', TRADE_ID);

  const sellerMsgs7 = await poll(mail.seller, '卖方');
  const prText = attachmentText(sellerMsgs7, '07-payment-requested.signed.json');
  if (prText === undefined) throw new Error('卖方未收到 PAYMENT_REQUESTED 邮件');
  sellerStore.applyEvent(TRADE_ID, parse(prText)); // → PAYMENT_PENDING

  // 人类完成支付（演示脚本自动标记）。
  const payTaskFile = join(BUYER_DIR, '.data', 'tasks', `${payTaskId}.json`);
  buyerTasks.complete(payTaskId, {
    payment_reference: 'BANK-CNY-20260823-0001',
    paid_amount_cny: '128.00',
    paid_at: '2026-08-23T02:00:00Z',
    channel: 'bank-transfer（虚构）',
  });
  log('步骤7', `人类完成 PAY 任务 ${payTaskId}（payment_reference=BANK-CNY-20260823-0001）`);

  const paymentConfirmed = await manual.confirm(deal, { store: sellerStore, agentId: SELLER, secretKey: sellerSeed });
  paymentConfirmedId = objectId(paymentConfirmed);
  const pcFile = writeArtifact('07-payment-confirmed.signed.json', serialize(paymentConfirmed));
  log('步骤7', `卖方确认收款：PAYMENT_CONFIRMED object_id=${paymentConfirmedId}`);
  await sendObj(mail.seller, BUYER_ADDR, '[trade] payment confirmed', paymentConfirmed, '07-payment-confirmed.signed.json', TRADE_ID);

  const buyerMsgs7 = await poll(mail.buyer, '买方');
  const pcText = attachmentText(buyerMsgs7, '07-payment-confirmed.signed.json');
  if (pcText === undefined) throw new Error('买方未收到 PAYMENT_CONFIRMED 邮件');
  buyerStore.applyEvent(TRADE_ID, parse(pcText)); // → PAYMENT_CONFIRMED

  summary.steps['7'] = {
    pay_task_id: payTaskId,
    pay_task_file: payTaskFile,
    payment_requested_event: paymentRequestedId,
    payment_requested_file: prFile,
    payment_confirmed_event: paymentConfirmedId,
    payment_confirmed_file: pcFile,
    buyer_state: buyerStore.stateOf(TRADE_ID),
    seller_state: sellerStore.stateOf(TRADE_ID),
  };

  })(), STEP_TIMEOUT_MS, '步骤7 钱包/人类支付');

  // =====================================================================
  // 步骤 8 — 人类生产验货发货（PRODUCE → FULFILLING，SHIP → SHIPPED）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(8, '人类生产验货发货（M7 任务：PRODUCE → FULFILLING，SHIP/验货 → SHIPPED）');

  const sellerTasks = createHumanTaskStore(sellerStore, { dir: SELLER_DIR });

  const produceId = sellerTasks.create({
    trade_id: TRADE_ID,
    task_type: 'PRODUCE',
    instructions: '生产 1 套 25cm 棉花娃娃豪华套装（心跳棉 + 手缝五官 + 礼服 B + 换装 C + 配件包）',
    required_output: ['produced_count', 'serial_no'],
  });
  sellerTasks.complete(produceId, { produced_count: 1, serial_no: 'CDS-2026-0001', quality: 'A' });
  const fulfillingEvent = sellerTasks.toEvent(produceId, 'FULFILLING', { agentId: SELLER, secretKey: sellerSeed });
  const fulfillingId = objectId(fulfillingEvent);
  const fulfillingFile = writeArtifact('08-fulfilling.signed.json', serialize(fulfillingEvent));
  log('步骤8', `人类完成生产任务 ${produceId} → 卖方签发 FULFILLING object_id=${fulfillingId}`);
  await sendObj(mail.seller, BUYER_ADDR, '[trade] fulfilling', fulfillingEvent, '08-fulfilling.signed.json', TRADE_ID);

  const buyerMsgs8a = await poll(mail.buyer, '买方');
  const flText = attachmentText(buyerMsgs8a, '08-fulfilling.signed.json');
  if (flText === undefined) throw new Error('买方未收到 FULFILLING 邮件');
  buyerStore.applyEvent(TRADE_ID, parse(flText)); // → FULFILLING

  const shipId = sellerTasks.create({
    trade_id: TRADE_ID,
    task_type: 'SHIP',
    instructions: '最终验货 + 防撞打包 + 交 demo-carrier 发货（顺丰式虚构承运）',
    required_output: ['inspected', 'tracking_no'],
  });
  sellerTasks.complete(shipId, {
    inspected: true,
    passed: true,
    inspection_note: '外观无瑕、填充饱满、配件齐全',
    tracking_no: 'SF-20260823-001',
    carrier: 'demo-carrier',
  });
  const shippedEvent = sellerTasks.toEvent(shipId, 'SHIPPED', { agentId: SELLER, secretKey: sellerSeed });
  const shippedId = objectId(shippedEvent);
  const shippedFile = writeArtifact('08-shipped.signed.json', serialize(shippedEvent));
  log('步骤8', `人类完成验货发货任务 ${shipId} → 卖方签发 SHIPPED object_id=${shippedId}`);
  await sendObj(mail.seller, BUYER_ADDR, '[trade] shipped', shippedEvent, '08-shipped.signed.json', TRADE_ID);

  const buyerMsgs8b = await poll(mail.buyer, '买方');
  const shText = attachmentText(buyerMsgs8b, '08-shipped.signed.json');
  if (shText === undefined) throw new Error('买方未收到 SHIPPED 邮件');
  buyerStore.applyEvent(TRADE_ID, parse(shText)); // → SHIPPED

  summary.steps['8'] = {
    produce_task_id: produceId,
    ship_task_id: shipId,
    fulfilling_event: fulfillingId,
    fulfilling_file: fulfillingFile,
    shipped_event: shippedId,
    shipped_file: shippedFile,
    buyer_state: buyerStore.stateOf(TRADE_ID),
    seller_state: sellerStore.stateOf(TRADE_ID),
  };

  })(), STEP_TIMEOUT_MS, '步骤8 人类生产验货发货');

  // =====================================================================
  // 步骤 9 — 物流签收事件（买方 RECEIVE 任务 → DELIVERED）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(9, '物流签收事件（买方 RECEIVE 任务 → DELIVERED）');

  receiveId = buyerTasks.create({
    trade_id: TRADE_ID,
    task_type: 'RECEIVE',
    instructions: '签收快递并核验内容物（对照目录规格与验收条件）',
    required_output: ['received', 'intact'],
  });
  buyerTasks.complete(receiveId, {
    received: true,
    intact: true,
    verified_item: 'cotton-doll-deluxe-set',
    damage_note: '无',
  });
  const deliveredEvent = buyerTasks.toEvent(receiveId, 'DELIVERED', { agentId: BUYER, secretKey: buyerSeed });
  const deliveredId = objectId(deliveredEvent);
  const deliveredFile = writeArtifact('09-delivered.signed.json', serialize(deliveredEvent));
  log('步骤9', `人类完成签收任务 ${receiveId} → 买方签发 DELIVERED object_id=${deliveredId}`);
  await sendObj(mail.buyer, SELLER_ADDR, '[trade] delivered', deliveredEvent, '09-delivered.signed.json', TRADE_ID);

  const sellerMsgs9 = await poll(mail.seller, '卖方');
  const dlText = attachmentText(sellerMsgs9, '09-delivered.signed.json');
  if (dlText === undefined) throw new Error('卖方未收到 DELIVERED 邮件');
  sellerStore.applyEvent(TRADE_ID, parse(dlText)); // → DELIVERED

  summary.steps['9'] = {
    receive_task_id: receiveId,
    delivered_event: deliveredId,
    delivered_file: deliveredFile,
    buyer_state: buyerStore.stateOf(TRADE_ID),
    seller_state: sellerStore.stateOf(TRADE_ID),
  };

  })(), STEP_TIMEOUT_MS, '步骤9 物流签收');

  // =====================================================================
  // 步骤 10 — 双方签名评价广播（COMPLETED + 双方 TRADE_RECEIPT → 双索引器）
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(10, '双方签名评价广播（COMPLETED → 双方回执 → 提交两个索引器）');

  const completedEvent = signed(
    'TRADE_EVENT',
    {
      event_id: 'evt-0010-completed',
      trade_id: TRADE_ID,
      event_type: 'COMPLETED',
      actor: BUYER,
      occurred_at: new Date().toISOString(),
      evidence: { final_acceptance: true, receiving_task: receiveId },
      message: 'delivery accepted; trade completed',
    },
    BUYER,
    buyerSeed,
  );
  const completedId = objectId(completedEvent);
  const completedFile = writeArtifact('10-completed.signed.json', serialize(completedEvent));
  buyerStore.applyEvent(TRADE_ID, completedEvent); // → COMPLETED
  await sendObj(mail.buyer, SELLER_ADDR, '[trade] completed', completedEvent, '10-completed.signed.json', TRADE_ID);

  const sellerMsgs10 = await poll(mail.seller, '卖方');
  const cpText = attachmentText(sellerMsgs10, '10-completed.signed.json');
  if (cpText === undefined) throw new Error('卖方未收到 COMPLETED 邮件');
  sellerStore.applyEvent(TRADE_ID, parse(cpText)); // → COMPLETED

  finalBuyerState = buyerStore.stateOf(TRADE_ID);
  finalSellerState = sellerStore.stateOf(TRADE_ID);
  log('步骤10', `状态链终态：买方=${finalBuyerState}，卖方=${finalSellerState}`);
  if (finalBuyerState !== 'COMPLETED' || finalSellerState !== 'COMPLETED') {
    throw new Error(`状态链未到 COMPLETED：buyer=${finalBuyerState} seller=${finalSellerState}`);
  }

  // 双方各自签发 TRADE_RECEIPT（公开证据包：deal_ref + settlement 事件 + bundle）。
  const dealFinal = buyerStore.getObject(dealObjectId);
  const receiptCommon = {
    trade_id: TRADE_ID,
    contract_hash: dealObjectId,
    evidence: {
      deal_ref: { object_id: dealObjectId, body_hash: dealFinal.body_hash },
      settlement_event_ref: paymentConfirmedId,
      bundle: [dealFinal],
    },
  };
  const buyerReceipt = signed(
    'TRADE_RECEIPT',
    {
      ...receiptCommon,
      receipt_id: 'receipt-2026-0001-buyer-to-seller',
      subject: SELLER,
      direction: 'buyer_to_seller',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      comment: '豪华套装按目录交付，沟通顺畅，发货迅速',
      metrics: { specification_match: true, delivery_hours: 72, communication_score: 5, overall_score: 5 },
      transaction_summary: { category: 'cotton-doll', asset: 'iso4217:CNY', amount_disclosure: 'exact', amount_range: ['128.00', '128.00'] },
    },
    BUYER,
    buyerSeed,
    '2026-08-23T12:00:00Z',
  );
  const sellerReceipt = signed(
    'TRADE_RECEIPT',
    {
      ...receiptCommon,
      receipt_id: 'receipt-2026-0002-seller-to-buyer',
      subject: BUYER,
      direction: 'seller_to_buyer',
      result: 'COMPLETED',
      rating: 'POSITIVE',
      comment: '买方按时付款，收货确认无异议',
      metrics: { specification_match: true, delivery_hours: 72, communication_score: 5, overall_score: 5 },
      transaction_summary: { category: 'cotton-doll', asset: 'iso4217:CNY', amount_disclosure: 'exact', amount_range: ['128.00', '128.00'] },
    },
    SELLER,
    sellerSeed,
    '2026-08-23T12:00:01Z',
  );
  const buyerReceiptFile = writeArtifact('10-receipt-buyer.signed.json', serialize(buyerReceipt));
  const sellerReceiptFile = writeArtifact('10-receipt-seller.signed.json', serialize(sellerReceipt));
  log('步骤10', `买方回执 object_id=${objectId(buyerReceipt)}，卖方回执 object_id=${objectId(sellerReceipt)}`);

  async function submitBoth(base, receipt) {
    const res = await httpJson(base, '/receipts', { method: 'POST', body: serialize(receipt) });
    return { status: res.status, json: res.json };
  }
  const buyerReceiptA = await submitBoth(baseA, buyerReceipt);
  const buyerReceiptB = await submitBoth(baseB, buyerReceipt);
  const sellerReceiptA = await submitBoth(baseA, sellerReceipt);
  const sellerReceiptB = await submitBoth(baseB, sellerReceipt);
  for (const [label, r] of [
    ['买方回执→检索站A', buyerReceiptA],
    ['买方回执→整合商B', buyerReceiptB],
    ['卖方回执→检索站A', sellerReceiptA],
    ['卖方回执→整合商B', sellerReceiptB],
  ]) {
    const status = r.json?.status ?? '?';
    log('步骤10', `${label}：HTTP ${r.status} status=${status} score=${r.json?.receipt?.score ?? '-'}`);
    if (r.status !== 201 && r.status !== 200) throw new Error(`${label} 收录失败：${JSON.stringify(r.json)}`);
  }

  summary.steps['10'] = {
    completed_event: completedId,
    completed_file: completedFile,
    buyer_state: finalBuyerState,
    seller_state: finalSellerState,
    buyer_receipt_file: buyerReceiptFile,
    seller_receipt_file: sellerReceiptFile,
    receipt_submissions: {
      buyer_to_a: buyerReceiptA.json?.status,
      buyer_to_b: buyerReceiptB.json?.status,
      seller_to_a: sellerReceiptA.json?.status,
      seller_to_b: sellerReceiptB.json?.status,
    },
    scores: {
      buyer_to_seller: { a: buyerReceiptA.json?.receipt?.score, b: buyerReceiptB.json?.receipt?.score },
      seller_to_buyer: { a: sellerReceiptA.json?.receipt?.score, b: sellerReceiptB.json?.receipt?.score },
    },
  };

  buyerStore.close();
  sellerStore.close();

  })(), STEP_TIMEOUT_MS, '步骤10 双方签名评价广播');

  // =====================================================================
  // 步骤 11 — 静态导出（双索引器）→ 杀服务器 → 离线查询
  // =====================================================================
  await withTimeout((async () => {
  stepBanner(11, '独立整合商收录 + 静态导出 + 离线查询');

  const snapshots = {};
  for (const [name, base] of [
    ['indexer-a', baseA],
    ['integrator-b', baseB],
  ]) {
    const res = await httpJson(base, '/export');
    if (res.status !== 200) throw new Error(`${name} /export 失败：${res.status}`);
    const snapshotFile = join(EXPORT_DIR, `${name}.json`);
    const sigFile = join(EXPORT_DIR, `${name}.sig`);
    writeFileSync(snapshotFile, JSON.stringify(res.json.snapshot, null, 2) + '\n', 'utf8');
    writeFileSync(sigFile, JSON.stringify(res.json.signature, null, 2) + '\n', 'utf8');
    const subjects = {};
    for (const s of res.json.snapshot.body.subjects) subjects[s.agent_id] = s.score;
    snapshots[name] = { snapshot_file: snapshotFile, sig_file: sigFile, weights_hash: res.json.snapshot.body.weights_hash, subjects };
    log('步骤11', `${name} 快照导出：${Object.entries(subjects).map(([k, v]) => `${k}=${v}`).join('，')}`);
  }

  // 杀服务器（含索引器实例），此后只剩静态文件（cleanup 幂等）。
  await Promise.all([serverA.close(), serverB.close()]);
  indexerA.close();
  indexerB.close();
  log('步骤11', '索引器服务器已全部关闭（离线状态）');

  // CLI 离线查询：验签 + 回答 subject 评分，无需服务器。
  const offlineQueries = {};
  for (const name of ['indexer-a', 'integrator-b']) {
    const snapshotPath = snapshots[name].snapshot_file;
    const sigPath = snapshots[name].sig_file;
    const q = runCli(['query', snapshotPath, '--subject', SELLER, '--sig', sigPath]);
    let parsed = null;
    try {
      parsed = JSON.parse(q.stdout);
    } catch {
      /* 非 JSON 输出 */
    }
    offlineQueries[name] = { exit: q.exitCode, stdout: q.stdout, verified: parsed?.verified, score: parsed?.score };
    log('步骤11', `${name} 离线查询（subject=${SELLER}）：exit=${q.exitCode} verified=${parsed?.verified} score=${parsed?.score}`);
  }

  // 另跑一次 CLI export（导出 → 离线查询）证明 CLI 静态导出路径同样可用。
  const cliExport = runCli(['export', '--store', INDEXER_A_DIR, '--output', join(EXPORT_DIR, 'cli-indexer-a.json'), '--indexer-id', 'indexer-a']);
  const cliExportOk = cliExport.exitCode === 0;
  const cliQuery = cliExportOk
    ? runCli(['query', join(EXPORT_DIR, 'cli-indexer-a.json'), '--subject', BUYER, '--sig', join(EXPORT_DIR, 'cli-indexer-a.sig')])
    : { exit: -1, stdout: '', stderr: cliExport.stderr };
  let cliQueryParsed = null;
  try {
    cliQueryParsed = JSON.parse(cliQuery.stdout);
  } catch {
    /* 非 JSON 输出 */
  }
  offlineQueries['cli-indexer-a'] = { exit: cliQuery.exitCode, verified: cliQueryParsed?.verified, score: cliQueryParsed?.score };
  log('步骤11', `CLI export→query：export_ok=${cliExportOk} query_exit=${cliQuery.exitCode} verified=${cliQueryParsed?.verified}`);

  summary.steps['11'] = {
    snapshots,
    offline_queries: offlineQueries,
    cli_export_ok: cliExportOk,
  };

  })(), STEP_TIMEOUT_MS, '步骤11 独立整合商收录+离线查询');

  // ---------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------
  summary.flags.all_states_completed = finalBuyerState === 'COMPLETED' && finalSellerState === 'COMPLETED';
  writeFileSync(join(RUN, 'demo-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  writeFileSync(join(RUN, 'demo.log'), logLines.join('\n') + '\n', 'utf8');
  log('done', `完成。摘要：runlog/demo-summary.json（object_id / 文件路径 / 评分全量记录）`);
  log('done', `下一步：node assertions.mjs`);
}

/** 全局看门狗：任何未被步骤超时/受控 I/O 覆盖的挂起，最迟 300s 强制退出。 */
const GLOBAL_WATCHDOG_MS = 300_000;
const watchdog = setTimeout(() => {
  console.error(`❌ 全局看门狗：脚本超过 ${GLOBAL_WATCHDOG_MS / 1000}s 仍未结束（存在未回收的挂起句柄），强制退出`);
  process.exit(1);
}, GLOBAL_WATCHDOG_MS);
watchdog.unref();

main()
  .catch((err) => {
    console.error(`\n❌ demo.mjs 失败：${err instanceof Error ? err.message : String(err)}`);
    if (err && err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    cleanupAll().finally(() => {
      writeFileSync(join(RUN, 'demo.log'), logLines.join('\n') + '\n', 'utf8');
    });
  });
