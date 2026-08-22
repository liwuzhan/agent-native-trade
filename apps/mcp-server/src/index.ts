#!/usr/bin/env node
/**
 * agent-trade MCP server entry (module M9). stdio transport only — V0 opens
 * no HTTP port (module card boundary: no Streamable HTTP, no remote access,
 * no OAuth).
 *
 * Configuration (environment):
 *   AGENT_TRADE_DATA_DIR  root directory holding `.data/` (objects, keys,
 *                         index.sqlite, optional policy.json). Defaults to
 *                         process.cwd().
 *   AGENT_TRADE_AGENT_ID  default signer/actor for tools that do not name
 *                         one. Defaults to "agent".
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createTradeApp } from './app.js';
import { createTradeServer } from './server.js';

const dir = process.env.AGENT_TRADE_DATA_DIR ?? process.cwd();
const agentId = process.env.AGENT_TRADE_AGENT_ID ?? 'agent';

const app = createTradeApp({ dir, agentId });

// One McpServer instance per connection, all sharing the process singleton
// app (single store, single voucher/task registry).
serveStdio(() => createTradeServer(app));
