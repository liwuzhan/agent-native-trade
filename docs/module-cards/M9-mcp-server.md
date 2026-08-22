# 模块卡片：M9 mcp-server

- **目标**：实现 `apps/mcp-server`——stdio MCP Server（SDK V2），把交易工具暴露给 Claude/Cursor 等异构 agent。**签名边界是本模块的红线。**
- **输入**：`@agent-trade/signed-files`（M2）、`@agent-trade/local-store`（M3）、`adapters/settlement`（M6）；技术选型 V0.4 §8.3。

## 输出

`apps/mcp-server/`，stdio 传输（V0 唯一，不开 HTTP 端口）。工具集（返回**简短摘要 + object_id**，不返回完整文件/历史）：

```text
trade_identity_create   trade_compile_deal    trade_sign_deal    trade_verify_deal
trade_record_event      trade_get_status      trade_create_receipt  trade_verify_receipt
settlement_request      settlement_confirm
```

**签名红线（必须实现为工具级约束）**：

- `trade_sign_deal` 只接受 `deal` 对象 + `expected_body_hash` 两个参数：先 Schema 验证 body、重算 `body_hash` 并与 `expected_body_hash` 比对，一致才签；**不提供通用任意字节签名接口**；
- 签约决策由调用方模型做出，**无人工确认环节**；可配置本地策略（如 `policy.json` 的 `max_amount_per_deal`），超限拒绝并返回原因；
- 私钥只读本机 `.data/keys/`，不出进程。

依赖：`@modelcontextprotocol/server`（V2）、内部三包；dev：`vitest`、`@modelcontextprotocol/client`（CI 冒烟）。

## 验收指标（即测试）

1. **CI 冒烟**：测试内用官方 MCP client 经 stdio 拉起 server → `listTools` 含全部 10 个工具 → `compile_deal→sign_deal→verify_deal` 往返通过。
2. 红线测试：`trade_sign_deal` 传错误 `expected_body_hash` 被拒；尝试签非 DEAL 对象/任意字节串被拒；超预算 DEAL 被策略拒绝。
3. 工具返回长度断言：每个工具响应 < 500 字符且含 object_id（防上下文膨胀）。
4. Claude Desktop / Cursor 连通性**仅作人工兼容性测试**，不进 CI，不阻塞合并。
5. `vitest run` 全绿；`tsc -b` 无错误。

## 边界

- 不做：Streamable HTTP、远程访问、OAuth；不做目录/邮件工具（那是 M4/M5 在 DSH 侧的接线，见 M10）。
