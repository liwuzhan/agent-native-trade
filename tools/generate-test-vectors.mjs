#!/usr/bin/env node
// agent-trade/0.2 测试向量生成器 —— 零依赖（仅 node:crypto）。
// 输出：protocol/test-vectors/vectors.json + openssl/ 交叉验签材料。
// 注意：向量中的私钥种子仅用于测试，禁止用于生产。
import { generateKeyPairSync, sign, verify, createHash, randomBytes, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'protocol', 'test-vectors');
const osslDir = join(outDir, 'openssl');
mkdirSync(osslDir, { recursive: true });

const PROTOCOL = 'agent-trade/0.2';

// ---------- JCS (RFC 8785) ----------
export function jcs(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('JCS: non-finite number');
    return String(v);
  }
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort(); // UTF-16 码元序
    return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  }
  throw new Error('JCS: unsupported type ' + t);
}

// ---------- helpers ----------
export const sha256hex = s => createHash('sha256').update(s, 'utf8').digest('hex');
const sha256hexBuf = b => createHash('sha256').update(b).digest('hex');
const b64u = b => Buffer.from(b).toString('base64url');
const b64uDecode = s => Buffer.from(s, 'base64url');

function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  let t = BigInt(now);
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { publicKey, privateKey, pub_b64u: b64u(pubRaw), seed_b64u: b64u(seed) };
}

// ---------- envelope ----------
export function buildEnvelope(objectType, body) {
  const bodyHash = 'sha256:' + sha256hex(jcs(body));
  const signingInput = Buffer.concat([
    Buffer.from(PROTOCOL, 'utf8'), Buffer.from([0]),
    Buffer.from(objectType, 'utf8'), Buffer.from([0]),
    Buffer.from(bodyHash, 'utf8'),
  ]);
  const objectId = 'sha256:' + sha256hexBuf(signingInput);
  return {
    file: { protocol: PROTOCOL, object_type: objectType, body, body_hash: bodyHash, signatures: [] },
    signingInput,
    objectId,
  };
}

export function addSignature(env, signerId, identity, issuedAt) {
  const sig = sign(null, env.signingInput, identity.privateKey);
  env.file.signatures.push({ signer: signerId, algorithm: 'Ed25519', signature: b64u(sig), issued_at: issuedAt });
  const ok = verify(null, env.signingInput, identity.publicKey, sig);
  if (!ok) throw new Error('self-check failed for ' + signerId);
  return sig;
}

// ---------- identities ----------
const buyer = makeIdentity();
const seller = makeIdentity();

// ---------- 样例：LISTING_REF ----------
const manifest = {
  files: [
    { path: 'catalog.json', sha256: sha256hex(jcs({ catalog_id: 'pudong_fasteners_week_34', items: ['bolt_M8_304_40'] })) },
    { path: 'items/bolt_M8_304_40.json', sha256: sha256hex(jcs({ item_id: 'bolt_M8_304_40', name: 'M8×40 304不锈钢螺栓', unit_price: '0.32' })) },
  ],
};
const catalogHash = 'sha256:' + sha256hex(jcs(manifest));

const listingEnv = buildEnvelope('LISTING_REF', {
  publisher: 'agent_seller',
  catalog_id: 'pudong_fasteners_week_34',
  catalog_hash: catalogHash,
  item_id: 'bolt_M8_304_40',
  item_revision: 7,
  distribution_refs: [
    { type: 'magnet', uri: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' },
    { type: 'https', uri: 'https://indexer.example.com/catalogs/pudong_fasteners_week_34.tar' },
  ],
});
addSignature(listingEnv, 'agent_seller', seller, '2026-08-22T02:00:00Z');

// ---------- 样例：DEAL（双签） ----------
const dealBody = {
  trade_id: uuidv7(),
  buyer: 'agent_buyer',
  seller: 'agent_seller',
  subject: {
    listing_ref: listingEnv.objectId,
    description: 'M8×40 304不锈钢螺栓',
    quantity: 10000,
    acceptance_conditions: ['材质符合约定', '数量误差不超过1%'],
  },
  settlement: {
    asset: 'iso4217:CNY',
    amount: '3200.00',
    method: 'manual-settlement',
    executor_ref: 'human_finance_department',
  },
  fulfillment: {
    deadline: '2026-09-10T00:00:00Z',
    destination_ref: 'private_address_01',
    carrier_ref: 'seller_selected',
  },
};
const dealEnv = buildEnvelope('DEAL', dealBody);
addSignature(dealEnv, 'agent_buyer', buyer, '2026-08-22T03:00:00Z');
addSignature(dealEnv, 'agent_seller', seller, '2026-08-22T03:05:00Z'); // 追加签名不破坏前一个

// ---------- 样例：TRADE_EVENT ----------
const eventEnv = buildEnvelope('TRADE_EVENT', {
  event_id: uuidv7(),
  trade_id: dealBody.trade_id,
  event_type: 'PAYMENT_CONFIRMED',
  actor: 'agent_seller',
  occurred_at: '2026-08-24T08:30:00Z',
  evidence: { method: 'manual-settlement', attested_by: 'human_finance_department' },
  message: '人类财务确认收款 3200.00 CNY',
});
addSignature(eventEnv, 'agent_seller', seller, '2026-08-24T08:31:00Z');

// ---------- 样例：TRADE_RECEIPT ----------
const receiptEnv = buildEnvelope('TRADE_RECEIPT', {
  receipt_id: uuidv7(),
  trade_id: dealBody.trade_id,
  contract_hash: dealEnv.file.body_hash,
  subject: 'agent_seller',
  direction: 'buyer_to_seller',
  result: 'COMPLETED',
  rating: 'POSITIVE',
  comment: '商品符合约定，三日内发货',
  metrics: { specification_match: true, delivery_hours: 72, communication_score: 4, overall_score: 5 },
  transaction_summary: { category: 'fasteners', asset: 'iso4217:CNY', amount_disclosure: 'range', amount_range: ['3000.00', '4000.00'] },
  evidence: {
    deal_ref: { object_id: dealEnv.objectId, body_hash: dealEnv.file.body_hash },
    settlement_event_ref: eventEnv.objectId,
  },
});
addSignature(receiptEnv, 'agent_buyer', buyer, '2026-09-02T02:00:00Z');

// ---------- 篡改样例 ----------
// A：改 body 不改 body_hash —— 杀手样例，专杀跳过重算哈希的验签器
const tamperedKeepHash = structuredClone(dealEnv.file);
tamperedKeepHash.body.subject.description = 'M8×40 316不锈钢螺栓';

// B：改 body 并重算 body_hash —— 签名输入含旧 hash，验签必失败
const tamperedRehash = structuredClone(dealEnv.file);
tamperedRehash.body.subject.description = 'M8×40 316不锈钢螺栓';
tamperedRehash.body_hash = 'sha256:' + sha256hex(jcs(tamperedRehash.body));
const tamperedRehashInput = Buffer.concat([
  Buffer.from(PROTOCOL, 'utf8'), Buffer.from([0]),
  Buffer.from('DEAL', 'utf8'), Buffer.from([0]),
  Buffer.from(tamperedRehash.body_hash, 'utf8'),
]);

// ---------- openssl 交叉验签材料 ----------
function exportOssl(caseName, input, file, signerIds) {
  writeFileSync(join(osslDir, `${caseName}.input.bin`), input);
  for (const id of signerIds) {
    const idt = id === 'agent_buyer' ? buyer : seller;
    writeFileSync(join(osslDir, `${caseName}.${id}.pem`), idt.publicKey.export({ format: 'pem', type: 'spki' }));
    const sig = file.signatures.find(s => s.signer === id);
    writeFileSync(join(osslDir, `${caseName}.${id}.sig`), b64uDecode(sig.signature));
  }
}
exportOssl('listing-ref-valid', listingEnv.signingInput, listingEnv.file, ['agent_seller']);
exportOssl('deal-valid', dealEnv.signingInput, dealEnv.file, ['agent_buyer', 'agent_seller']);
exportOssl('trade-event-valid', eventEnv.signingInput, eventEnv.file, ['agent_seller']);
exportOssl('trade-receipt-valid', receiptEnv.signingInput, receiptEnv.file, ['agent_buyer']);
// 负例：用旧签名验新输入，OpenSSL 必须拒绝
exportOssl('deal-tampered-rehash', tamperedRehashInput, dealEnv.file, ['agent_buyer', 'agent_seller']);

// ---------- vectors.json ----------
const vectors = {
  spec: PROTOCOL,
  warning: '私钥种子仅用于测试向量，禁止用于生产。',
  identities: {
    agent_buyer: { public_key: buyer.pub_b64u, seed: buyer.seed_b64u },
    agent_seller: { public_key: seller.pub_b64u, seed: seller.seed_b64u },
  },
  cases: [
    { name: 'listing-ref-valid', object_type: 'LISTING_REF', file: listingEnv.file, object_id: listingEnv.objectId, expect: 'valid' },
    { name: 'deal-valid', object_type: 'DEAL', file: dealEnv.file, object_id: dealEnv.objectId, expect: 'valid' },
    { name: 'trade-event-valid', object_type: 'TRADE_EVENT', file: eventEnv.file, object_id: eventEnv.objectId, expect: 'valid' },
    { name: 'trade-receipt-valid', object_type: 'TRADE_RECEIPT', file: receiptEnv.file, object_id: receiptEnv.objectId, expect: 'valid' },
    { name: 'deal-tampered-body-keep-hash', object_type: 'DEAL', file: tamperedKeepHash, expect: 'fail:body_hash_mismatch', tamper: 'description 被改，body_hash 与签名原样保留' },
    { name: 'deal-tampered-body-rehash', object_type: 'DEAL', file: tamperedRehash, expect: 'fail:signature_invalid', tamper: 'description 被改且 body_hash 重算，签名输入失配' },
  ],
};
writeFileSync(join(outDir, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n');

console.log('vectors.json written:');
for (const c of vectors.cases) console.log(`  ${c.name}  expect=${c.expect}`);
console.log('object_ids:');
console.log('  LISTING_REF  ', listingEnv.objectId);
console.log('  DEAL         ', dealEnv.objectId);
console.log('  TRADE_EVENT  ', eventEnv.objectId);
console.log('  TRADE_RECEIPT', receiptEnv.objectId);
console.log('openssl materials:', osslDir);
