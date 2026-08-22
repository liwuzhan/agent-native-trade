#!/usr/bin/env node
// 参考验签器：严格按 protocol/specification.md §3 的四步执行。
// （第③步 JSON Schema 验证由 ajv 另行执行：npx ajv-cli compile --spec=draft2020）
import { verify, createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vectors = JSON.parse(readFileSync(join(root, 'protocol/test-vectors/vectors.json'), 'utf8'));

function jcs(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') { if (!Number.isFinite(v)) throw new Error('JCS: non-finite'); return String(v); }
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  }
  throw new Error('JCS: unsupported type');
}
const sha256hex = s => createHash('sha256').update(s, 'utf8').digest('hex');

function pubFromRaw(b64u) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64u, 'base64url')]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// 四步验签（schema 校验外置）。返回结果码。
export function verifyFile(file, identities) {
  // ① 重算 body_hash 并比对 —— 跳过此步的实现等于没有验证
  const actual = 'sha256:' + sha256hex(jcs(file.body));
  if (actual !== file.body_hash) return 'fail:body_hash_mismatch';
  // ② 重算 object_id（签名输入）
  const input = Buffer.concat([
    Buffer.from(file.protocol, 'utf8'), Buffer.from([0]),
    Buffer.from(file.object_type, 'utf8'), Buffer.from([0]),
    Buffer.from(file.body_hash, 'utf8'),
  ]);
  // ④ 逐条验签（严格 RFC 8032，node:crypto 即严格模式）
  for (const s of file.signatures) {
    const idt = identities[s.signer];
    if (!idt) return 'fail:unknown_signer';
    const ok = verify(null, input, pubFromRaw(idt.public_key), Buffer.from(s.signature, 'base64url'));
    if (!ok) return 'fail:signature_invalid';
  }
  return 'valid';
}

let bad = 0;
for (const c of vectors.cases) {
  const got = verifyFile(c.file, vectors.identities);
  const pass = got === c.expect;
  if (!pass) bad++;
  console.log(`${pass ? 'OK ' : 'BAD'}  ${c.name.padEnd(34)} got=${got}`);
}
if (bad) { console.error(`${bad} case(s) FAILED`); process.exit(1); }
console.log('all vector cases match expectations');
