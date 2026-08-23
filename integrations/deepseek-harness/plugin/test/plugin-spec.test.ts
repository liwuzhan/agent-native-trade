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

import { describe, expect, it } from 'vitest';

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
