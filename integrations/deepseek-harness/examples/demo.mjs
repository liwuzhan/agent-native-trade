/**
 * demo.mjs — M10 最小链路脚本化演示（零 npm 依赖，仅 node 内建）。
 *
 * 链路（M10 卡片验收指标 1）：
 *   catalog_search → catalog_get_item → 邮件联系（M5 文件信箱）→
 *   trade_compile_deal → 买方 trade_sign_deal →（DEAL 信封邮件附件传递）→
 *   卖方 trade_sign_deal →（回传）→ 买方 trade_verify_deal === valid
 *
 * 两个 daemon 子进程分别扮演买方/卖方（各自 tradeDir/私钥/收件地址），共享
 * catalog 与 maildrop。本脚本扮演"模型"：发起工具调用、做决策、做断言。
 *
 * 同机演示捷径（注释标注）：双方从各自 store 的 objects/ 读已存信封 ——
 * 跨机时该信封经邮件附件传递（本脚本第 6/7 步已演示这条真实路径）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startDaemon } from './lib/jsonl-client.mjs';

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const ROOT = process.env.AGENT_TRADE_DEMO_ROOT ?? join(HOME, '.agent-trade');
const REPO = new URL('../../..', import.meta.url).pathname;
const SERVER_JS = join(REPO, 'integrations/deepseek-harness/plugin/dist/server.js');
const RUNLOG = new URL('./runlog/', import.meta.url).pathname;

const buyerDir = join(ROOT, 'buyer');
const sellerDir = join(ROOT, 'seller');
const catalogDir = join(ROOT, 'catalog');
const maildropDir = join(ROOT, 'maildrop');

// ── 模型角色所需的最小协议原语（与 @agent-trade/identity 的 JCS/SHA-256 定义一致）──
function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
}
const recomputeBodyHash = (body) => 'sha256:' + createHash('sha256').update(jcs(body), 'utf8').digest('hex');
const uuidv7 = () => {
  const ms = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(9).toString('hex'); // 18 hex chars
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6)}`;
};

function readStoredObject(dir, objectId) {
  // 同机捷径：双方 store 的 objects/ 是签名文件真相源（跨机走邮件附件，见第 6/7 步）
  return JSON.parse(readFileSync(join(dir, '.data', 'objects', 'sha256', objectId.slice('sha256:'.length) + '.json'), 'utf8'));
}

const logLines = [];
const step = (n, title) => {
  const line = `[${String(n).padStart(2, '0')}] ${title}`;
  logLines.push(line);
  console.log(line);
};
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
  logLines.push(`      ✓ ${message}`);
};

const tradeId = uuidv7();
const dealBody = {
  trade_id: tradeId,
  buyer: 'agent_buyer',
  seller: 'agent_seller',
  subject: {
    listing_ref: 'sha256:9f6b6feedc2ddf9e27765a5b1a975c61e32fcd1191d6b552389c043cc56844f6',
    description: 'M8 不锈钢螺栓，每包 100 颗',
    quantity: 10,
    acceptance_conditions: ['304 不锈钢', '每包 100 颗'],
  },
  settlement: { asset: 'CNY', amount: '12.00', method: 'test-voucher', provider_ref: 'demo' },
  fulfillment: { deadline: '2026-09-01T00:00:00Z', destination_ref: 'shelf-a3', carrier_ref: 'demo-carrier' },
};

/** daemon canonical 返回 {ok, object_id, summary}；summary 内是工具摘要 JSON。 */
const unwrap = (client, name, args) => client.call(name, args).then((r) => JSON.parse(r.summary));
const B = (name, args) => unwrap(buyer, name, args);
const S = (name, args) => unwrap(seller, name, args);

const buyer = startDaemon(SERVER_JS, [
  '--dir', buyerDir,
  '--agent-id', 'agent_buyer',
  '--catalog-dir', catalogDir,
  '--maildrop', maildropDir,
  '--mail-address', 'buyer@trade.local',
  '--mail-peer', 'seller@trade.local',
]);
const seller = startDaemon(SERVER_JS, [
  '--dir', sellerDir,
  '--agent-id', 'agent_seller',
  '--catalog-dir', catalogDir,
  '--maildrop', maildropDir,
  '--mail-address', 'seller@trade.local',
  '--mail-peer', 'buyer@trade.local',
]);

try {
  await Promise.all([buyer.ready(), seller.ready()]);
  step(1, 'catalog_search（买方检索目录找货）');
  const search = await B('catalog_search', { query: '螺栓', catalog_dir: catalogDir });
  assert(Array.isArray(search.matches) && search.matches.length === 1, '命中 1 条');
  assert(search.matches[0].i === 'bolt-m8', 'item_id = bolt-m8');
  assert(/^sha256:[0-9a-f]{64}$/.test(search.object_id), 'LISTING_REF object_id 有效');
  const listingObjectId = search.object_id;

  step(2, 'catalog_get_item（买方取详情）');
  const item = await B('catalog_get_item', { object_id: listingObjectId, catalog_dir: catalogDir });
  assert(item.item_id === 'bolt-m8' && item.listing_ref_valid === true, '详情 + 有效 LISTING_REF');
  assert(typeof item.price === 'string' && item.price.length > 0, `价格 ${item.price}`);

  step(3, '邮件联系（M5：议价一问一答）');
  await B('trade_contact_seller', { trade_id: tradeId, subject: '议价', text: '螺栓能便宜点吗？' });
  const sellerInbox = await S('trade_contact_seller', { trade_id: tradeId, poll: true });
  assert(sellerInbox.new_messages === 1, '卖方收到 1 封');
  const firstMsg = sellerInbox.messages[0];
  await S('trade_contact_seller', { trade_id: tradeId, subject: 'Re: 议价', text: '量大从优，先按 12 元/包。', in_reply_to: firstMsg.message_id });
  const buyerInbox = await B('trade_contact_seller', { trade_id: tradeId, poll: true });
  assert(buyerInbox.new_messages === 1, '买方收到回复（线程关联）');

  step(4, 'trade_compile_deal（买方起草，编译只发生一次）');
  const compiled = await B('trade_compile_deal', { body: dealBody });
  const bodyHash = compiled.body_hash;
  assert(/^sha256:[0-9a-f]{64}$/.test(bodyHash), `body_hash=${bodyHash}`);
  assert(compiled.trade_id === tradeId, 'trade_id 一致');

  step(5, 'trade_sign_deal（买方签；expected_body_hash 独立传入）');
  const draftEnvelope = { protocol: 'agent-trade/0.2', object_type: 'DEAL', body: dealBody, body_hash: bodyHash, signatures: [] };
  const buyerSigned = await B('trade_sign_deal', { deal: draftEnvelope, expected_body_hash: bodyHash, signer: 'agent_buyer' });
  const buyerEnvelope = readStoredObject(buyerDir, buyerSigned.object_id); // 同机捷径：跨机走第 6 步附件
  assert(buyerEnvelope.signatures.length === 1, '买方签名落账');

  step(6, 'DEAL 信封经邮件附件传给卖方，卖方审签同一文件');
  await B('trade_contact_seller', {
    trade_id: tradeId,
    subject: 'DEAL 待签',
    text: '请审签：附件为已签 DEAL 信封。',
    attachments: [{ filename: 'deal.json', content: JSON.stringify(buyerEnvelope) }],
  });
  const sellerMail = await S('trade_contact_seller', { trade_id: tradeId, poll: true });
  const dealAttachment = sellerMail.messages.flatMap((m) => m.attachments).find((a) => a.filename === 'deal.json');
  assert(dealAttachment !== undefined, '卖方收到 DEAL 附件');
  const receivedEnvelope = JSON.parse(readFileSync(dealAttachment.path, 'utf8'));
  const sellerExpected = recomputeBodyHash(receivedEnvelope.body);
  assert(sellerExpected === bodyHash, '卖方独立重算 body_hash 一致');
  const sellerSigned = await S('trade_sign_deal', { deal: receivedEnvelope, expected_body_hash: sellerExpected, signer: 'agent_seller' });
  const sellerEnvelope = readStoredObject(sellerDir, sellerSigned.object_id); // 同机捷径
  assert(sellerEnvelope.signatures.length === 2, '双签（增签不破旧签）');

  step(7, '双签文件回传买方，trade_verify_deal === valid');
  await S('trade_contact_seller', {
    trade_id: tradeId,
    subject: 'DEAL 已双签',
    text: '已签回。',
    attachments: [{ filename: 'deal-signed.json', content: JSON.stringify(sellerEnvelope) }],
  });
  const buyerMail = await B('trade_contact_seller', { trade_id: tradeId, poll: true });
  const finalAttachment = buyerMail.messages.flatMap((m) => m.attachments).find((a) => a.filename === 'deal-signed.json');
  assert(finalAttachment !== undefined, '买方收到双签文件');
  const finalEnvelope = JSON.parse(readFileSync(finalAttachment.path, 'utf8'));
  const verified = await B('trade_verify_deal', { deal: finalEnvelope });
  assert(verified.result === 'valid', `trade_verify_deal === ${verified.result}`);

  step(8, '状态机收尾（双方 DEAL_SIGNED → AGREED）');
  await B('trade_record_event', { trade_id: tradeId, event_type: 'DEAL_SIGNED', actor: 'agent_buyer' });
  const buyerState = await B('trade_get_status', { trade_id: tradeId });
  assert(buyerState.state === 'AGREED', `买方状态 ${buyerState.state}`);

  step(9, '总结：M10 最小链路 9 步全部通过 ✅');
  mkdirSync(RUNLOG, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(RUNLOG, `minimal-trade-${stamp}.log`), logLines.join('\n') + '\n');
  console.log(`runlog: examples/runlog/minimal-trade-${stamp}.log`);
} finally {
  await Promise.all([buyer.stop(), seller.stop()]);
}
