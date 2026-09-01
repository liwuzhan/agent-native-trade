/**
 * plugin-spec.test.ts — plugin.mjs 的注册层 schema 转换与工具规格一致性。
 *
 * 背景（真实会话失败复盘，2026-08-23）：静态注册不经过 defineTool 归一化，
 * 参数若为 property-map（无根 type:'object'）会原样到达模型适配器并报
 * "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"。
 * 本测试锁死转换产物为合法 JSON Schema（每个工具都有根 type、required 键
 * 都存在于 properties）。
 */

import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import * as plugin from '../plugin.mjs';
import { dshParametersOf } from '../plugin.mjs';

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

describe('dshParametersOf（plugin.mjs 注册层转换）', () => {
  const spec = JSON.parse(readFileSync(new URL('../tool-spec.json', import.meta.url), 'utf8')) as { tools: ToolSpec[] };

  it('每个工具的 parameters 都是根级 type:"object" 的标准 JSON Schema', () => {
    for (const tool of spec.tools) {
      const converted = dshParametersOf(tool.parameters);
      expect(converted.type, `${tool.name}: 根级 type 必须是 object`).toBe('object');
      expect(converted.properties, `${tool.name}: properties 必须是对象`).toBeTypeOf('object');
    }
  });

  it('catalog_get_item（真实会话失败工具）产出合法 JSON Schema', () => {
    const tool = spec.tools.find((t) => t.name === 'catalog_get_item');
    expect(tool).toBeDefined();
    const converted = dshParametersOf(tool!.parameters);
    expect(converted).toEqual({
      type: 'object',
      properties: {
        item_id: { type: 'string', description: expect.any(String) },
        object_id: { type: 'string', description: expect.any(String) },
        catalog_hash: { type: 'string', description: expect.any(String) },
        indexer_url: { type: 'string', description: expect.any(String) },
        indexer_urls: { type: 'array', description: expect.any(String), items: { type: 'string' } },
        catalog_dir: { type: 'string', description: expect.any(String) },
      },
    });
  });

  it('required 数组保留且每个键都存在于 properties', () => {
    for (const tool of spec.tools) {
      const converted = dshParametersOf(tool.parameters);
      const required = (tool.parameters.required as string[] | undefined) ?? [];
      if (required.length === 0) {
        expect(converted.required).toBeUndefined();
        continue;
      }
      expect(converted.required, `${tool.name}: required 应保留`).toEqual(required);
      for (const key of required) {
        expect(converted.properties[key], `${tool.name}: required 键 ${key} 缺失`).toBeDefined();
      }
    }
  });

  it('enum 与 array items 原样透传', () => {
    const settlement = spec.tools.find((t) => t.name === 'settlement_request')!;
    const converted = dshParametersOf(settlement.parameters);
    expect(converted.properties.method.enum).toContain('test-voucher');
    const contact = spec.tools.find((t) => t.name === 'trade_contact_seller')!;
    expect(dshParametersOf(contact.parameters).properties.attachments.type).toBe('array');
  });

  it('contact bridge 工具：message_ref 为 object、to 为 string array（注册层形状）', () => {
    const get = spec.tools.find((t) => t.name === 'contact_message_get')!;
    const getParams = dshParametersOf(get.parameters);
    expect(getParams.required).toEqual(['message_ref']);
    expect(getParams.properties.message_ref).toMatchObject({ type: 'object' });
    const send = spec.tools.find((t) => t.name === 'contact_send')!;
    const sendParams = dshParametersOf(send.parameters);
    expect(sendParams.properties.to).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(sendParams.required).toEqual(['to', 'text']);
    const reply = spec.tools.find((t) => t.name === 'contact_reply')!;
    expect(dshParametersOf(reply.parameters).required).toEqual(['message_ref', 'text']);
  });
});

/**
 * DSH 0.1.2 运行时契约（2026-09）：tools 服务晚于 bundle apply 提供，
 * 插件必须用 inject 等待；cordis 4 用 ctx.effect 管理外部资源清理。
 * 本组测试锁死这些契约，防止退回 ctx.get 静默路径。
 */
describe('plugin.mjs 与 DSH 0.1.2 运行时契约', () => {
  interface RegisteredTool {
    name: string;
    description: string;
    parameters: { type: string; properties: Record<string, unknown> };
    output: { schema: { type: string }; render: (args: unknown, value: unknown) => unknown[] };
    execute: (args: unknown, exec: unknown) => Promise<unknown>;
  }

  function setup() {
    const registered: RegisteredTool[] = [];
    const spawns: Record<string, unknown>[] = [];
    const effects: Array<() => void> = [];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let resolveDone: ((outcome: unknown) => void) | undefined;
    const done = new Promise((resolve) => (resolveDone = resolve));
    const terminate = vi.fn();
    const handle = {
      stdin: { write: vi.fn() },
      stdout,
      stderr,
      done,
      terminate,
    };
    const ctx = {
      tools: { register: (def: RegisteredTool) => registered.push(def) },
      subprocess: { spawn: (sp: Record<string, unknown>) => { spawns.push(sp); return handle; } },
      effect: (fn: () => () => void) => effects.push(fn()),
    };
    return { registered, spawns, effects, stdout, stderr, handle, terminate, resolveDone, ctx };
  }

  it('inject 必须是 tools + subprocess（0.1.2 硬依赖，防止静默跳过回归）', () => {
    expect(plugin.inject).toEqual(['tools', 'subprocess']);
  });

  it('apply 注册全部 23 个工具，且 schema 有根级 type:"object"', () => {
    const { registered, effects, handle, ctx } = setup();
    plugin.apply(ctx as never, {});
    expect(registered).toHaveLength(23);
    for (const tool of registered) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.output.schema.type).toBe('object');
    }
    expect(effects).toHaveLength(1);
    // 未 spawn 时 dispose 是安全 no-op（懒启动的 daemon 尚未创建）
    effects[0]();
    expect(handle.terminate).not.toHaveBeenCalled();
  });

  it('execute → 懒 spawn → JSONL ready/响应往返 → 结果透传', async () => {
    const { registered, spawns, stdout, handle, resolveDone, effects, ctx } = setup();
    plugin.apply(ctx as never, {});
    const ident = registered.find((t) => t.name === 'trade_identity_create')!;

    const pending = ident.execute({}, { signal: undefined });
    expect(spawns).toHaveLength(1);
    const spawnSpec = spawns[0] as { argv: string[]; cwd: string; stdio: { stdin: string }; graceMs: number };
    expect(spawnSpec.argv).toContain('serve');
    const agentIdAt = spawnSpec.argv.indexOf('--agent-id');
    expect(agentIdAt).toBeGreaterThan(-1);
    expect(spawnSpec.argv[agentIdAt + 1]).toBe('agent');
    expect(spawnSpec.argv).toContain('--indexers');
    expect(spawnSpec.graceMs).toBe(5000);
    expect(spawnSpec.stdio.stdin).toBe('pipe');
    expect(spawnSpec.argv[1]).toMatch(/runtime\/server\.mjs$/);

    stdout.emit('data', Buffer.from('{"event":"ready"}\n'));
    // ready → ensure() 的 await 继续 → stdin.write 是微任务时序：
    // 必须先等请求写出再回放响应（真实 daemon 也只会先收后回）。
    await vi.waitFor(() => expect(handle.stdin.write).toHaveBeenCalledOnce());
    expect(handle.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ id: '1', tool: 'trade_identity_create', args: {} }) + '\n',
    );
    stdout.emit(
      'data',
      Buffer.from('{"id":"1","ok":true,"result":{"ok":true,"object_id":"identity:test","summary":"identity test created"}}\n'),
    );
    await expect(pending).resolves.toEqual({ ok: true, object_id: 'identity:test', summary: 'identity test created' });

    effects[0]();
    expect(handle.terminate).toHaveBeenCalledOnce();
    resolveDone!({ exitCode: 0, signal: null });
  });

  it('daemon ok:false 响应 → execute 拒绝并带 daemon 错误信息', async () => {
    const { registered, stdout, handle, resolveDone, effects, ctx } = setup();
    plugin.apply(ctx as never, {});
    const ident = registered.find((t) => t.name === 'trade_identity_create')!;
    const pending = ident.execute({}, undefined);
    stdout.emit('data', Buffer.from('{"event":"ready"}\n'));
    await vi.waitFor(() => expect(handle.stdin.write).toHaveBeenCalledOnce());
    stdout.emit('data', Buffer.from('{"id":"1","ok":false,"error":{"message":"boom"}}\n'));
    await expect(pending).rejects.toThrow('boom');
    effects[0]();
    resolveDone!({ exitCode: 0, signal: null });
  });
});
