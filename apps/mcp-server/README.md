# @agent-trade/mcp-server (M9)

agent-trade/0.2 交易工具的 **stdio MCP 服务器**（SDK V2，`@modelcontextprotocol/server`），把 10 个交易工具暴露给 Claude Desktop / Cursor 等异构 agent。V0 仅 stdio 传输，不开 HTTP 端口（卡片边界：无 Streamable HTTP、远程访问、OAuth）。

## 构建与测试

```bash
npm install          # file: 接线到 ../../packages/{identity,signed-files,local-store} 与 ../../adapters/settlement
npm test             # pretest 自动：提取 body schema + tsc -b，然后 vitest run
npm run build        # node scripts/extract-body-schemas.mjs && tsc -b
```

CI 冒烟（`test/`）：

| 文件 | 覆盖 |
|---|---|
| `smoke.test.ts` | 官方 MCP client（InMemory 传输）listTools 含全部 10 工具；compile→sign→verify 往返；全流程 happy path；每个响应 < 500 字符且含 object_id |
| `redline.test.ts` | 签名红线：错误 expected_body_hash 拒绝、非 DEAL 对象/任意字节拒绝、schema 失败拒绝、不一致 draft 拒绝、无本地私钥拒绝、无通用任意字节签名接口、双签叠加 |
| `policy.test.ts` | 超预算拒绝（含原因）、恰好等于上限放行、易货（无金额）放行、`.data/policy.json` 本地覆盖、非法配置快速失败 |
| `settlement.test.ts` | test-voucher 与 manual-settlement 全流程；任务未 DONE 拒绝确认；deal 无效/状态机未就绪拒绝 |
| `stdio.test.ts` | **真实 stdio 拉起**（spawn `dist/index.js`）→ listTools → 往返 → happy path（Claude Desktop/Cursor 的部署形态） |
| `schemas-sync.test.ts` | body schema 与 `protocol/schemas/` 权威源防漂移 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_TRADE_DATA_DIR` | `process.cwd()` | 数据根目录（含 `.data/`：`objects/` 事实文件、`keys/` 私钥、`index.sqlite`、可选 `policy.json`） |
| `AGENT_TRADE_AGENT_ID` | `agent` | 未显式指定 signer/actor 时的默认身份 |

## 签名红线（本模块硬约束）

- `trade_sign_deal` 只接受 `deal` 对象 + `expected_body_hash`（+ 可选 `signer` 选择本地密钥）；先 Schema 验证 body、重算 `body_hash` 并与 `expected_body_hash` 比对一致才签；**无通用任意字节签名接口**。
- 签约决策由调用方模型做出，**无人工确认环节**；本地策略 `policy.json`（`max_amount_per_deal`）可拒绝超限 deal 并返回原因。
- 私钥只读本机 `.data/keys/`（0600），永不出进程；调用方只能指名 signer，不能提供密钥。

策略加载顺序：`createTradeServer` 显式传入 → `.data/policy.json` → 随包 `policy.json`（默认无上限）。

## 人工兼容性测试（Claude Desktop / Cursor，不进 CI，不阻塞合并）

> 前置：`npm install && npm run build`；首次连接前先给本地身份建钥（可用 MCP 工具的 `trade_identity_create`，或直接把测试向量种子写入 `.data/keys/agent_buyer.key`）。

**Claude Desktop**：编辑 `claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "agent-trade": {
      "command": "node",
      "args": ["/绝对路径/agent-trade-protocol/apps/mcp-server/dist/index.js"],
      "env": { "AGENT_TRADE_DATA_DIR": "/绝对路径/agent-trade-protocol/apps/mcp-server/.data" }
    }
  }
}
```

**Cursor**：项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "agent-trade": {
      "command": "node",
      "args": ["/绝对路径/agent-trade-protocol/apps/mcp-server/dist/index.js"],
      "env": { "AGENT_TRADE_DATA_DIR": "/绝对路径/agent-trade-protocol/apps/mcp-server/.data" }
    }
  }
}
```

重启客户端后确认：MCP 面板出现 agent-trade，且 10 个工具全部列出。然后让模型走一遍：`trade_identity_create`（或确认已有身份）→ `trade_compile_deal` → `trade_sign_deal` → `trade_verify_deal` → `trade_record_event`(DEAL_SIGNED) → `settlement_request` → `settlement_confirm` → `trade_get_status`。每步返回都应 < 500 字符且含 `object_id`。

## 边界

不做：Streamable HTTP、远程访问、OAuth；不做目录/邮件工具（M4/M5 在 DSH 侧接线，见 M10）。
