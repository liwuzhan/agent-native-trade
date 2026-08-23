/**
 * contact-flow.mjs — contact bridge（runtime bridge contract）脚本化演示
 * （零 npm 依赖，仅 node 内建）。
 *
 * 链路（maildrop loopback，模拟 trade-inboxd 的 WakeTask 生成职责）：
 *   1. 买方 contact_send 首触询价（contact_refs 场景）
 *   2. inboxd-sim 扫描卖方 spool 落信 → 生成 WakeTask（不含正文）
 *   3. 卖方 contact_wake_list 领取 → contact_message_get 取正文（此时才进上下文）
 *   4. 卖方 contact_reply 回信
 *   5. inboxd-sim 为买方生成回信 WakeTask → 买方领取/取信（线程 + trade_id 关联）
 *   6. 双方 contact_wake_ack → 队列清空（done/ 保留去重证据）
 *
 * 真实部署中 2/5 步由 trade-inboxd（agentmail WebSocket 收信 + FileWakeQueue）
 * 完成；本脚本用同一目录结构与文件格式模拟，保证与生产队列二进制兼容。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startDaemon } from './lib/jsonl-client.mjs';

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const ROOT = process.env.AGENT_TRADE_DEMO_ROOT ?? join(HOME, '.agent-trade');
const REPO = new URL('../../..', import.meta.url).pathname;
const SERVER_JS = join(REPO, 'integrations/deepseek-harness/plugin/dist/server.js');
const RUNLOG = new URL('./runlog/', import.meta.url).pathname;

const buyerDir = join(ROOT, 'buyer');
const sellerDir = join(ROOT, 'seller');
const maildropDir = join(ROOT, 'maildrop');
const wakeQueueDir = join(ROOT, 'contact');

const BUYER = 'buyer@trade.local';
const SELLER = 'seller@trade.local';
const PROVIDER = 'maildrop';
const TRADE_ID = 'trade-contact-demo-9';

// ── 与 packages/contact-core/src/wake.ts 一致的确定性 task_id 算法 ──
const wakeTaskId = (provider, inboxId, messageId) =>
  'wake_' + createHash('sha256').update([provider, inboxId, messageId].join('\0'), 'utf8').digest('hex').slice(0, 32);

/** 从落盘 .eml 里解析顶层头（From/Subject/X-Trade-Id）——inboxd 的真实数据源。 */
function parseEmHeaders(source) {
  const text = source.toString('utf8');
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const headers = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return headers;
}

/** 找到 inbox 目录里 messageId 对应的 .eml 并生成 WakeTask（inboxd-sim）。 */
function enqueueWakeTask(inboxAddress, messageId) {
  const dir = join(maildropDir, inboxAddress);
  const meta = readdirSync(dir)
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    .find((m) => m.messageId === messageId);
  if (!meta) throw new Error(`inboxd-sim: message ${messageId} not found in ${inboxAddress}`);
  const headers = parseEmHeaders(readFileSync(join(dir, `${meta.uid}.eml`)));
  const task = {
    version: 'agent-trade-wake-task/0.1',
    type: 'contact.message.received',
    task_id: wakeTaskId(PROVIDER, inboxAddress, messageId),
    created_at: new Date().toISOString(),
    channel: 'email',
    provider: PROVIDER,
    event_id: `evt_${meta.uid}`,
    inbox_id: inboxAddress,
    message_ref: { provider: PROVIDER, inbox_id: inboxAddress, message_id: messageId },
    ...(meta.inReplyTo ? { thread_id: meta.inReplyTo } : {}),
    from: headers.from ?? '',
    ...(headers.subject ? { subject: headers.subject } : {}),
    ...(headers['x-trade-id'] ? { trade_id: headers['x-trade-id'] } : {}),
    received_at: new Date().toISOString(),
    trust: 'untrusted',
    next_actions: ['contact_message_get'],
  };
  mkdirSync(join(wakeQueueDir, 'pending'), { recursive: true, mode: 0o700 });
  const path = join(wakeQueueDir, 'pending', `${task.task_id}.json`);
  writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return task;
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

/** daemon canonical 返回 {ok, object_id, summary}；summary 内是工具摘要 JSON。 */
const unwrap = (client, name, args) => client.call(name, args).then((r) => JSON.parse(r.summary));
const B = (name, args) => unwrap(buyer, name, args);
const S = (name, args) => unwrap(seller, name, args);

const buyer = startDaemon(SERVER_JS, [
  '--dir', buyerDir,
  '--agent-id', 'agent_buyer',
  '--maildrop', maildropDir,
  '--mail-address', BUYER,
  '--mail-peer', SELLER,
  '--wake-queue', wakeQueueDir,
  '--contact-provider', PROVIDER,
]);
const seller = startDaemon(SERVER_JS, [
  '--dir', sellerDir,
  '--agent-id', 'agent_seller',
  '--maildrop', maildropDir,
  '--mail-address', SELLER,
  '--mail-peer', BUYER,
  '--wake-queue', wakeQueueDir,
  '--contact-provider', PROVIDER,
]);

try {
  await Promise.all([buyer.ready(), seller.ready()]);

  step(1, 'contact_send（买方按 contact_refs 首触询价）');
  const sent = await B('contact_send', { to: [SELLER], subject: '询价', text: 'M8x40 螺栓一箱多少钱？', trade_id: TRADE_ID });
  assert(sent.status === 'sent' && sent.to[0] === SELLER, `已发出 ${sent.to[0]}`);
  assert(/^<maildrop-/.test(sent.message_ref.message_id), '出站 message_id 有效');

  step(2, 'inboxd-sim：落信 → WakeTask（不含正文）');
  const sellerTask = enqueueWakeTask(SELLER, sent.message_ref.message_id);
  assert(sellerTask.task_id.startsWith('wake_'), `WakeTask ${sellerTask.task_id}`);
  assert(JSON.stringify(sellerTask).indexOf('一箱多少钱') === -1, 'WakeTask 不含正文');

  step(3, '卖方 contact_wake_list → contact_message_get（正文此时才进上下文）');
  const sellerList = await S('contact_wake_list', {});
  assert(sellerList.total_pending === 1, '卖方队列 1 个待办');
  const task = sellerList.tasks[0];
  assert(task.message_ref.message_id === sent.message_ref.message_id, 'message_ref 与出站信一致');
  const mail = await S('contact_message_get', { message_ref: task.message_ref });
  assert(mail.from === BUYER, `发件人 ${mail.from}`);
  assert(mail.text.indexOf('一箱多少钱') !== -1, '正文可读');
  assert(mail.trade_id === TRADE_ID, 'X-Trade-Id 关联一致');

  step(4, '卖方 contact_reply（线程 + trade_id 继承）');
  const replied = await S('contact_reply', { message_ref: task.message_ref, text: '一箱 420 USDC，含税。' });
  assert(replied.status === 'replied' && replied.in_reply_to === task.message_ref.message_id, '回信已发');
  await S('contact_wake_ack', { task_id: task.task_id });
  assert((await S('contact_wake_list', {})).total_pending === 0, '卖方 ack 后队列清空');

  step(5, 'inboxd-sim：回信落买方箱 → WakeTask → 买方领取取信');
  const buyerTask = enqueueWakeTask(BUYER, replied.message_ref.message_id);
  const buyerList = await B('contact_wake_list', {});
  assert(buyerList.total_pending === 1, '买方队列 1 个待办');
  const back = await B('contact_message_get', { message_ref: buyerList.tasks[0].message_ref });
  assert(back.from === SELLER, `回信来自 ${back.from}`);
  assert(back.text.indexOf('420 USDC') !== -1, '回信正文可读');
  assert(back.thread_id === sent.message_ref.message_id, '线程关联到首触信');

  step(6, '买方 ack → 双方队列清空（done/ 保留去重证据）');
  await B('contact_wake_ack', { task_id: buyerTask.task_id });
  assert((await B('contact_wake_list', {})).total_pending === 0, '买方队列清空');
  assert(existsSync(join(wakeQueueDir, 'done', `${buyerTask.task_id}.json`)), 'done/ 保留去重证据');

  step(7, '总结：contact bridge 6 步全链路通过 ✅');
  mkdirSync(RUNLOG, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(RUNLOG, `contact-flow-${stamp}.log`), logLines.join('\n') + '\n');
  console.log(`runlog: examples/runlog/contact-flow-${stamp}.log`);
} finally {
  await Promise.all([buyer.stop(), seller.stop()]);
}
