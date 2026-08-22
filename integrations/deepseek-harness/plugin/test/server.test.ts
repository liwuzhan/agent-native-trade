/**
 * server.test.ts — M10 逻辑层单测（宿主层逻辑与 DSH 注册分离：直接构造 DshApp
 * 调 handlers，不经过 DSH 运行时）+ daemon JSONL 冒烟。
 *
 * 复用 M9 的向量身份（protocol/test-vectors/vectors.json 的 agent_buyer /
 * agent_seller）与 DEAL body 样例形状（apps/mcp-server/test/helpers.ts）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { buildManifest, catalogHash } from '@agent-trade/bt-catalog';
import { generateIdentity } from '@agent-trade/identity';
import { addSignature, buildObject } from '@agent-trade/signed-files';
import { uuidv7 } from '@agent-trade/human-task';

import { createDshApp } from '../src/app.js';
import type { DshApp } from '../src/app.js';
import { isPlainObject, wrapResult } from '../src/contract.js';
import { catalogGetItem, catalogSearch } from '../src/handlers/catalog.js';
import { tradeContactSeller } from '../src/handlers/contact.js';
import { humanTaskCancel, humanTaskComplete, humanTaskCreate, humanTaskList } from '../src/handlers/human-task.js';
import { tradeBroadcastReceipt } from '../src/handlers/broadcast.js';
import { identityCreate } from '@agent-trade/mcp-server/handlers/identity';
import { compileDeal, signDeal, verifyDeal } from '@agent-trade/mcp-server/handlers/deal';
import { getStatus, recordEvent } from '@agent-trade/mcp-server/handlers/event';
import { createReceipt, verifyReceipt } from '@agent-trade/mcp-server/handlers/receipt';

interface Harness {
  dir: string;
  app: DshApp;
  cleanup(): void;
}

const cleanups: Harness[] = [];

afterEach(() => {
  for (const h of cleanups.splice(0)) {
    try {
      h.app.close();
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

function makeHarness(opts: Partial<Parameters<typeof createDshApp>[0]> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-'));
  const app = createDshApp({ dir, agentId: 'agent_buyer', ...opts });
  const vectors = JSON.parse(readFileSync(new URL('../../../../protocol/test-vectors/vectors.json', import.meta.url), 'utf8')) as {
    identities: Record<string, { public_key: string; seed: string }>;
  };
  for (const [agentId, identity] of Object.entries(vectors.identities)) {
    app.store.saveKey(agentId, identity.seed);
  }
  const harness = { dir, app, cleanup: () => undefined };
  harness.cleanup = () => {
    try {
      app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  cleanups.push(harness);
  return harness;
}

/** 把对方公钥写入 .data/peers/<id>.pub（信任环扩展；私钥永不出机）。 */
function savePeerKey(dir: string, agentId: string, publicKey: string): void {
  const peers = join(dir, '.data', 'peers');
  mkdirSync(peers, { recursive: true });
  writeFileSync(join(peers, `${agentId}.pub`), publicKey, 'utf8');
}

function makeDealBody(tradeId = '01a02a10-d06d-7306-8a94-868702c2611e'): Record<string, unknown> {
  return {
    trade_id: tradeId,
    buyer: 'agent_buyer',
    seller: 'agent_seller',
    subject: {
      listing_ref: 'sha256:9f6b6feedc2ddf9e27765a5b1a975c61e32fcd1191d6b552389c043cc56844f6',
      description: 'M8x40 304 stainless steel bolts, 40 mm',
      quantity: 100,
      acceptance_conditions: ['M8x40 304 stainless steel', 'packed per 100'],
    },
    settlement: { asset: 'USDC', amount: '420.00', method: 'test-voucher', provider_ref: 'test-voucher-issuer' },
    fulfillment: { deadline: '2026-09-01T00:00:00Z', destination_ref: 'shelf-a3', carrier_ref: 'test-carrier' },
  };
}

function dealEnvelope(body: Record<string, unknown>, bodyHash: string): Record<string, unknown> {
  return { protocol: 'agent-trade/0.2', object_type: 'DEAL', body, body_hash: bodyHash, signatures: [] };
}

function makeReceiptBody(tradeId: string, contractHash: string): Record<string, unknown> {
  return {
    receipt_id: uuidv7(),
    trade_id: tradeId,
    contract_hash: contractHash,
    subject: 'agent_seller',
    direction: 'buyer_to_seller',
    result: 'COMPLETED',
    rating: 'POSITIVE',
    comment: 'delivered on time',
  };
}

describe('M10 最小链路（DSH 注册之外的全部宿主层逻辑）', () => {
  it('identity → compile → 双方 sign → verify === valid → 事件 → 状态 → 回执 → 广播', async () => {
    const { dir, app } = makeHarness();

    // 身份
    const id = identityCreate({ agentId: 'demo_agent' }, app);
    expect(id.object_id).toBe('identity:demo_agent');

    // 起草（编译只发生一次）
    const compiled = await compileDeal({ body: makeDealBody() }, app);
    expect(compiled.body_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const bodyHash = compiled.body_hash as string;

    // 买方签
    const envelope = dealEnvelope(makeDealBody(), bodyHash);
    const signedByBuyer = await signDeal({ deal: envelope, expected_body_hash: bodyHash, signer: 'agent_buyer' }, app);
    expect(signedByBuyer.status).toBe('signed');

    // 卖方审签同一文件（增签不破旧签）：从 store 取买方签好的完整信封
    const buyerSignedFile = app.store.getObject(signedByBuyer.object_id as string);
    expect(buyerSignedFile).toBeDefined();
    const signedBySeller = await signDeal(
      { deal: buyerSignedFile, expected_body_hash: bodyHash, signer: 'agent_seller' },
      app,
    );
    // 验签（四步）=== valid
    const verified = verifyDeal({ object_id: signedBySeller.object_id }, app);
    expect(verified.result).toBe('valid');

    // 状态机：DEAL_SIGNED → AGREED
    const tradeId = '01a02a10-d06d-7306-8a94-868702c2611e';
    const ev = await recordEvent({ trade_id: tradeId, event_type: 'DEAL_SIGNED', actor: 'agent_buyer' }, app);
    expect(getStatus({ trade_id: tradeId }, app).state).toBe('AGREED');
    expect(ev.object_id).toMatch(/^sha256:/);

    // 回执（双签后的 deal 作为合同）
    const receipt = await createReceipt(
      { body: makeReceiptBody(tradeId, signedBySeller.object_id as string), signer: 'agent_buyer' },
      app,
    );
    expect(verifyReceipt({ receipt: app.store.getObject(receipt.object_id as string) }, app).result).toBe('valid');

    // 广播（dht 关，无 tracker 也产生 magnet）
    const broadcast = await tradeBroadcastReceipt({ object_id: receipt.object_id }, app);
    expect(broadcast.object_id).toBe(receipt.object_id);
    expect(broadcast.magnet_uri).toMatch(/^magnet:\?/);
    expect(wrapResult(broadcast).summary.length).toBeLessThan(500);

    // 产物证据包落盘
    const receiptFile = join(dir, '.data', 'bundles', receipt.object_id as string, 'receipt.json');
    expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toMatchObject({ object_type: 'TRADE_RECEIPT' });
  });

  it('签名红线：expected_body_hash 不符拒绝；非 DEAL 拒绝；policy 超限拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-redline-'));
    const vectors = JSON.parse(readFileSync(new URL('../../../../protocol/test-vectors/vectors.json', import.meta.url), 'utf8')) as {
      identities: Record<string, { public_key: string; seed: string }>;
    };
    // 先写 policy（max 100），再构造 app（loadPolicy 启动时读取）
    mkdirSync(join(dir, '.data'), { recursive: true });
    writeFileSync(join(dir, '.data', 'policy.json'), JSON.stringify({ max_amount_per_deal: '100.00' }), 'utf8');
    const app = createDshApp({ dir, agentId: 'agent_buyer' });
    for (const [agentId, identity] of Object.entries(vectors.identities)) {
      app.store.saveKey(agentId, identity.seed);
    }
    cleanups.push({ dir, app, cleanup: () => app.close() });

    const body = makeDealBody();
    const compiled = await compileDeal({ body }, app);
    const bodyHash = compiled.body_hash as string;
    const envelope = dealEnvelope(body, bodyHash);

    // 红线 1：哈希不符
    await expect(signDeal({ deal: envelope, expected_body_hash: 'sha256:' + 'b'.repeat(64), signer: 'agent_buyer' }, app)).rejects.toThrow(
      /body_hash mismatch/,
    );
    // 红线 2：签非 DEAL 对象
    await expect(
      signDeal({ deal: { protocol: 'agent-trade/0.2', object_type: 'TRADE_EVENT', body: {} }, expected_body_hash: bodyHash, signer: 'agent_buyer' }, app),
    ).rejects.toThrow(/expected object_type "DEAL"/);
    // 红线 3：超预算（policy max 100，DEAL 420）
    await expect(signDeal({ deal: envelope, expected_body_hash: bodyHash, signer: 'agent_buyer' }, app)).rejects.toThrow(/policy|amount/i);
  });

  it('目录工具：搜索命中 + 取详情 + 不可信数据防线', async () => {
    const { dir, app } = makeHarness();
    // 卖方身份 + LISTING_REF
    const seller = generateIdentity();
    app.store.saveKey('seller_x', seller.secretKey);
    savePeerKey(dir, 'seller_x', seller.publicKey);

    const catalogDir = join(dir, 'catalog');
    mkdirSync(catalogDir, { recursive: true });
    const itemData = new TextEncoder().encode(
      JSON.stringify({ item_id: 'bolt-m8', title: 'M8 不锈钢螺栓', description: '304 材质 40mm', price: { amount: '12.00', currency: 'CNY' }, tags: ['螺栓', '五金'] }),
    );
    writeFileSync(join(catalogDir, 'bolt-m8.json'), itemData);
    const otherData = new TextEncoder().encode(
      JSON.stringify({ item_id: 'doll-cotton', title: '棉花娃娃', description: '20cm 定制', price: '66.00', tags: ['玩偶'] }),
    );
    writeFileSync(join(catalogDir, 'doll-cotton.json'), otherData);

    const manifest = buildManifest([
      { path: 'bolt-m8.json', data: itemData },
      { path: 'doll-cotton.json', data: otherData },
    ]);
    const refBody = {
      publisher: 'seller_x',
      catalog_id: 'demo-catalog',
      catalog_hash: catalogHash(manifest),
      item_id: 'bolt-m8',
      distribution_refs: [{ type: 'file', uri: 'catalog/bolt-m8.json' }],
    };
    const ref = addSignature(buildObject('LISTING_REF', refBody), 'seller_x', seller.secretKey);
    writeFileSync(join(catalogDir, 'bolt-m8.listing-ref.json'), JSON.stringify(ref));

    // 搜索命中 + object_id 有效
    const found = catalogSearch({ query: '螺栓', catalog_dir: catalogDir }, app);
    expect(found.matches).toHaveLength(1);
    expect((found.matches as { i: string }[])[0].i).toBe('bolt-m8');
    expect(found.object_id).toMatch(/^sha256:/);

    // 取详情（按 object_id 反查 item）
    const detail = catalogGetItem({ object_id: found.object_id, catalog_dir: catalogDir }, app);
    expect(detail.item_id).toBe('bolt-m8');
    expect(detail.listing_ref_valid).toBe(true);
    expect(detail.catalog_hash).toBe(catalogHash(manifest));

    // 不可信数据防线：超大文件被跳过，不炸搜索
    writeFileSync(join(catalogDir, 'huge.json'), Buffer.alloc(64 * 1024, 0x61));
    const after = catalogSearch({ query: '螺栓', catalog_dir: catalogDir }, app);
    expect(after.matches).toHaveLength(1);

    // 摘要硬上限
    expect(wrapResult(found).summary.length).toBeLessThan(500);
    expect(wrapResult(detail).summary.length).toBeLessThan(500);
  });

  it('human tasks：create → list → complete 状态机', async () => {
    const { app } = makeHarness();
    const created = humanTaskCreate(
      { trade_id: 'trade-1', task_type: 'PAY', instructions: '线下转账后回报单号', required_output: ['receipt_no'] },
      app,
    );
    const taskId = created.task_id as string;

    const listed = humanTaskList({}, app);
    expect(listed.tasks).toHaveLength(1);
    expect((listed.tasks as { status: string }[])[0].status).toBe('PENDING');

    const done = humanTaskComplete({ task_id: taskId, result: { receipt_no: 'R-123' } }, app);
    expect(done.status).toBe('DONE');
    // DONE 不可再 complete / cancel
    expect(() => humanTaskComplete({ task_id: taskId, result: {} }, app)).toThrow(/PENDING/);
    expect(() => humanTaskCancel({ task_id: taskId }, app)).toThrow(/PENDING/);

    const t2 = humanTaskCreate({ trade_id: 'trade-2', task_type: 'INSPECT', instructions: '验货' }, app);
    expect(humanTaskCancel({ task_id: t2.task_id as string }, app).status).toBe('CANCELLED');
  });

  it('邮件联系：file-maildrop 跨进程语义（两个 app 共享 spool）往返', async () => {
    const spool = mkdtempSync(join(tmpdir(), 'dsh-maildrop-'));
    const buyer = createDshApp({
      dir: mkdtempSync(join(tmpdir(), 'dsh-buyer-')),
      agentId: 'buyer',
      maildropDir: spool,
      mailAddress: 'buyer@trade.local',
      mailPeer: 'seller@trade.local',
    });
    const seller = createDshApp({
      dir: mkdtempSync(join(tmpdir(), 'dsh-seller-')),
      agentId: 'seller',
      maildropDir: spool,
      mailAddress: 'seller@trade.local',
      mailPeer: 'buyer@trade.local',
    });
    cleanups.push(
      { dir: buyer.dir, app: buyer, cleanup: () => buyer.close() },
      { dir: seller.dir, app: seller, cleanup: () => seller.close() },
    );

    const sent = await tradeContactSeller(
      { trade_id: 'trade-9', to: 'seller@trade.local', subject: '议价', text: '螺栓能便宜点吗？' },
      buyer,
    );
    expect(sent.status).toBe('sent');

    const inbox = await tradeContactSeller({ trade_id: 'trade-9', poll: true }, seller);
    expect(inbox.new_messages).toBe(1);
    const msg = (inbox.messages as { from: string; text: string }[])[0];
    expect(msg.from).toBe('buyer@trade.local');
    expect(msg.text).toContain('螺栓');

    // 回复（in_reply_to 关联）
    const reply = await tradeContactSeller(
      { trade_id: 'trade-9', to: 'buyer@trade.local', subject: 'Re: 议价', text: '可以，量大从优。', in_reply_to: (inbox.messages as { message_id: string }[])[0].message_id },
      seller,
    );
    expect(reply.status).toBe('sent');
    const buyerInbox = await tradeContactSeller({ trade_id: 'trade-9', poll: true }, buyer);
    expect(buyerInbox.new_messages).toBe(1);
  });
});

describe('daemon JSONL 冒烟', () => {
  it('spawn → ready → identity_create → 未知工具错误 → SIGTERM 退出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-daemon-'));
    const serverJs = new URL('../dist/server.js', import.meta.url).pathname;
    const child = spawn(process.execPath, [serverJs, 'serve', '--dir', dir, '--agent-id', 'demo'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let buffer = '';
      const lines: string[] = [];
      const waiters: Array<() => void> = [];
      const drain = (): void => {
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          lines.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
        waiters.splice(0).forEach((w) => w());
      };
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        drain();
      });
      const nextLine = async (timeoutMs = 30000): Promise<string> => {
        const deadline = Date.now() + timeoutMs;
        while (lines.length === 0) {
          if (Date.now() > deadline) throw new Error(`timeout waiting for daemon line; buffered=${JSON.stringify(buffer)}`);
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
            setTimeout(resolve, 50);
          });
        }
        return lines.shift() as string;
      };

      const ready = JSON.parse(await nextLine());
      expect(ready).toEqual({ event: 'ready' });

      child.stdin.write(JSON.stringify({ id: '1', tool: 'trade_identity_create', args: { agentId: 'probe_agent' } }) + '\n');
      const resp = JSON.parse(await nextLine());
      expect(resp).toMatchObject({ id: '1', ok: true });
      expect(resp.result.ok).toBe(true);
      expect(resp.result.object_id).toBe('identity:probe_agent');
      expect(resp.result.summary.length).toBeLessThan(500);

      child.stdin.write(JSON.stringify({ id: '2', tool: 'nope', args: {} }) + '\n');
      const errResp = JSON.parse(await nextLine());
      expect(errResp).toMatchObject({ id: '2', ok: false });
      expect(errResp.error.message).toContain('unknown tool');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('工具规格与注册层一致性', () => {
  it('tool-spec.json 与 daemon 分发表对齐（18 工具）', async () => {
    const spec = JSON.parse(readFileSync(new URL('../tool-spec.json', import.meta.url), 'utf8')) as { tools: { name: string }[] };
    const names = spec.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'catalog_get_item',
        'catalog_search',
        'human_task_cancel',
        'human_task_complete',
        'human_task_create',
        'human_task_list',
        'settlement_confirm',
        'settlement_request',
        'trade_broadcast_receipt',
        'trade_compile_deal',
        'trade_contact_seller',
        'trade_create_receipt',
        'trade_get_status',
        'trade_identity_create',
        'trade_record_event',
        'trade_sign_deal',
        'trade_verify_deal',
        'trade_verify_receipt',
      ],
    );
  });

  it('isPlainObject 与 wrapResult 摘要上限（工具返回防膨胀）', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(() => wrapResult({ object_id: 'x'.repeat(700) })).toThrow();
  });
});
