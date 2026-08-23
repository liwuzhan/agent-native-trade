/**
 * contract.test.ts — JSONL 信封与长度红线的单元测试。
 */

import { describe, expect, it } from 'vitest';

import { isPlainObject, wrapError, wrapResult } from '../src/contract.js';

describe('wrapResult', () => {
  it('包出 {ok, object_id, summary} canonical 值', () => {
    const value = wrapResult({ object_id: 'sha256:' + 'a'.repeat(64), foo: 1 });
    expect(value).toEqual({ ok: true, object_id: 'sha256:' + 'a'.repeat(64), summary: expect.any(String) });
    expect(value.summary).toBe(JSON.stringify({ object_id: 'sha256:' + 'a'.repeat(64), foo: 1 }));
  });

  it('摘要 ≥ 500 字符时抛错（响亮 bug 好过静默膨胀）', () => {
    expect(() => wrapResult({ object_id: 'x'.repeat(600) })).toThrow(/too long/);
  });

  it('按工具级上限放宽（contact bridge：按需取正文是有界例外）', () => {
    const big = { object_id: 'message:maildrop:a:b', text: 'x'.repeat(1000) };
    expect(() => wrapResult(big)).toThrow(/too long/);
    const relaxed = wrapResult(big, 96 * 1024);
    expect(relaxed.ok).toBe(true);
    expect(relaxed.summary).toBe(JSON.stringify(big));
    // 上限本身仍是硬断言
    expect(() => wrapResult({ text: 'y'.repeat(97 * 1024) }, 96 * 1024)).toThrow(/too long/);
  });

  it('无 object_id 字段时回退为空串', () => {
    expect(wrapResult({ foo: 1 }).object_id).toBe('');
  });
});

describe('wrapError', () => {
  it('错误进入 summary 且 object_id 为空', () => {
    const value = wrapError('boom');
    expect(value.ok).toBe(false);
    expect(value.object_id).toBe('');
    expect(value.summary).toContain('boom');
  });

  it('超长错误被截断', () => {
    const value = wrapError('x'.repeat(5000));
    expect(value.summary.length).toBeLessThan(500);
  });
});

describe('isPlainObject', () => {
  it('区分对象/数组/null/标量', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
});
