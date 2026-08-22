/**
 * lib/mcp.mjs — stdio MCP 客户端封装（M9）。
 *
 * 以官方 `@modelcontextprotocol/client`（V2）拉起 `apps/mcp-server/dist/index.js`
 * 子进程（Claude Desktop / Cursor 的部署形态），按工具返回结构化摘要
 * （< 500 字符 + object_id）。M10 推迟后，演示用"包 + MCP"编排：
 * 买方经 MCP 起草/签署 DEAL，卖方经 MCP 审签 + 记录 DEAL_SIGNED。
 *
 * 子进程 stderr 持续排空（防止背压阻塞，并保存下来用于诊断）。
 */

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** mcp-server 的 stdio 入口（相对本文件 lib/：../../../apps/mcp-server/dist/index.js）。 */
export const MCP_ENTRY = fileURLToPath(new URL('../../../apps/mcp-server/dist/index.js', import.meta.url));

export class MCPHandle {
  /**
   * @param {object} opts
   * @param {string} opts.dir  AGENT_TRADE_DATA_DIR（该进程独占此 store 目录）
   * @param {string} opts.agentId 默认 signer/actor
   */
  static async start({ dir, agentId = 'agent' }) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_ENTRY],
      env: { ...process.env, AGENT_TRADE_DATA_DIR: dir, AGENT_TRADE_AGENT_ID: agentId },
      stderr: 'pipe',
    });
    const handle = new MCPHandle(new Client({ name: 'llm-doll-demo', version: '0.1.0' }, { capabilities: {} }), transport);
    // 显式消费传输层错误（避免未处理的 onclose 抛错击穿主进程）。
    transport.onerror = (error) => {
      handle.transportErrors.push(error instanceof Error ? error.message : String(error));
    };
    await handle.client.connect(transport);
    return handle;
  }

  constructor(client, transport) {
    this.client = client;
    this.transport = transport;
    this.closed = false;
    this.stderrChunks = [];
    this.transportErrors = [];
    // 排空子进程 stderr：既防背压，也保留诊断输出。
    this.transport.stderr?.on('data', (chunk) => {
      this.stderrChunks.push(chunk.toString());
    });
  }

  get stderrText() {
    return this.stderrChunks.join('');
  }

  /**
   * 调用一个工具；返回 { isError, text, data }（data 为 structuredContent）。
   * SDK/协议层抛错同样记为 isError，与 M9 测试的 callTool 语义一致。
   */
  async call(name, args = {}) {
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text, data: result.structuredContent ?? undefined };
    } catch (error) {
      return {
        isError: true,
        text: error instanceof Error ? error.message : String(error),
        data: undefined,
        stderr: this.stderrText,
      };
    }
  }

  /** 关闭连接并终止子进程（transport.close 会 SIGTERM→SIGKILL 兜底）。 */
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      /* 忽略 */
    }
    try {
      await this.transport.close();
    } catch {
      /* 忽略 */
    }
  }
}
