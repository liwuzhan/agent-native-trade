/**
 * contract.ts — DSH plugin ⇄ daemon JSONL protocol + response envelope.
 *
 * 协议（每行一个 JSON 值，无换行转义内容）：
 *   → { "id": string, "tool": string, "args": object }
 *   ← { "id": string, "ok": true,  "result": { ok, object_id, summary } }
 *   ← { "id": string, "ok": false, "error": { message } }
 *   ← { "event": "ready" }          // daemon 启动完成（一次性）
 *
 * 长度红线（同 M9 MAX_RESPONSE_CHARS）：工具摘要序列化后必须 < 500 字符，
 * 超限视为内部错误并抛错（响亮的 bug 好过静默的上下文膨胀）。
 */

import { MAX_RESPONSE_CHARS } from '@agent-trade/mcp-server/shared';

export interface JsonRpcRequest {
  id: string;
  tool: string;
  args?: unknown;
}

export interface JsonRpcOk {
  id: string;
  ok: true;
  result: DshToolResult;
}

export interface JsonRpcErr {
  id: string;
  ok: false;
  error: { message: string };
}

export type JsonRpcResponse = JsonRpcOk | JsonRpcErr;

/** canonical 值：plugin.mjs 侧 output.schema 的精确形状（见 INSPECTION.md 3.1）。 */
export interface DshToolResult {
  ok: boolean;
  object_id: string;
  summary: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 handler 返回的摘要对象包成 canonical 值。
 * `object_id` 取摘要对象的 object_id 字段（无则空串）；summary = 紧凑 JSON 文本。
 * 序列化长度 ≥ MAX_RESPONSE_CHARS 时抛错（M9 同款硬断言）。
 */
export function wrapResult(value: Record<string, unknown>): DshToolResult {
  const text = JSON.stringify(value);
  if (text.length >= MAX_RESPONSE_CHARS) {
    throw new Error(`internal error: tool summary too long (${text.length} chars >= ${MAX_RESPONSE_CHARS})`);
  }
  return {
    ok: true,
    object_id: typeof value.object_id === 'string' ? value.object_id : '',
    summary: text,
  };
}

/** 错误 → canonical 值（summary 截断到安全长度）。 */
export function wrapError(message: string): DshToolResult {
  const text = `error: ${message}`;
  return { ok: false, object_id: '', summary: text.slice(0, MAX_RESPONSE_CHARS - 16) };
}
