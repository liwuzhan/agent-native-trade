#!/usr/bin/env node

import { homedir } from 'node:os';
import { join } from 'node:path';

import { startTracker } from '@agent-trade/bt-catalog';
import { compileDeal, signDeal, verifyDeal } from '@agent-trade/mcp-server/handlers/deal';
import { getStatus, recordEvent } from '@agent-trade/mcp-server/handlers/event';
import { identityCreate } from '@agent-trade/mcp-server/handlers/identity';
import { createReceipt, verifyReceipt } from '@agent-trade/mcp-server/handlers/receipt';
import { settlementConfirm, settlementRequest } from '@agent-trade/mcp-server/handlers/settlement';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createDshApp } from '../../../deepseek-harness/plugin/src/app.js';
import type { DshApp } from '../../../deepseek-harness/plugin/src/app.js';
import { wrapResult } from '../../../deepseek-harness/plugin/src/contract.js';
import { parseIndexerUrls } from '../../../deepseek-harness/plugin/src/indexers.js';
import { tradeBroadcastReceipt } from '../../../deepseek-harness/plugin/src/handlers/broadcast.js';
import { catalogGetItem, catalogSearch } from '../../../deepseek-harness/plugin/src/handlers/catalog.js';
import {
  contactMessageGet,
  contactReply,
  contactSend,
  tradeContactSeller,
} from '../../../deepseek-harness/plugin/src/handlers/contact.js';
import {
  humanTaskCancel,
  humanTaskComplete,
  humanTaskCreate,
  humanTaskList,
} from '../../../deepseek-harness/plugin/src/handlers/human-task.js';
import { contactWakeAck, contactWakeList } from '../../../deepseek-harness/plugin/src/handlers/wake.js';
import rawToolSpec from '../../../deepseek-harness/plugin/tool-spec.json' with { type: 'json' };

type Handler = (
  args: Record<string, unknown>,
  app: DshApp,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const SUMMARY_CAPS: Record<string, number> = {
  contact_message_get: 96 * 1024,
  contact_wake_list: 16 * 1024,
};

const READ_ONLY = new Set([
  'catalog_search',
  'catalog_get_item',
  'contact_wake_list',
  'contact_message_get',
  'trade_verify_deal',
  'trade_get_status',
  'trade_verify_receipt',
  'human_task_list',
]);

const DISPATCH: Record<string, Handler> = {
  trade_identity_create: identityCreate as Handler,
  catalog_search: catalogSearch,
  catalog_get_item: catalogGetItem,
  trade_contact_seller: tradeContactSeller,
  contact_wake_list: contactWakeList,
  contact_wake_ack: contactWakeAck,
  contact_message_get: contactMessageGet,
  contact_reply: contactReply,
  contact_send: contactSend,
  trade_compile_deal: compileDeal as Handler,
  trade_sign_deal: signDeal as Handler,
  trade_verify_deal: verifyDeal as Handler,
  trade_record_event: recordEvent as Handler,
  trade_get_status: getStatus as Handler,
  trade_create_receipt: createReceipt as Handler,
  trade_verify_receipt: verifyReceipt as Handler,
  trade_broadcast_receipt: tradeBroadcastReceipt,
  human_task_create: humanTaskCreate,
  human_task_complete: humanTaskComplete,
  human_task_list: humanTaskList,
  human_task_cancel: humanTaskCancel,
  settlement_request: settlementRequest as Handler,
  settlement_confirm: settlementConfirm as Handler,
};

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function createApp(): DshApp {
  const pluginData = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  const dir = process.env.AGENT_TRADE_DATA_DIR ?? pluginData ?? join(homedir(), '.agent-trade');
  const contactProvider = process.env.AGENT_TRADE_CONTACT_PROVIDER ?? 'maildrop';
  if (contactProvider !== 'agentmail' && contactProvider !== 'maildrop') {
    throw new Error('AGENT_TRADE_CONTACT_PROVIDER must be agentmail or maildrop');
  }

  return createDshApp({
    dir,
    agentId: process.env.AGENT_TRADE_AGENT_ID,
    catalogDir: process.env.AGENT_TRADE_CATALOG_DIR ?? join(dir, 'catalog'),
    indexerUrls: parseIndexerUrls(process.env.AGENT_TRADE_INDEXERS),
    maildropDir: process.env.AGENT_TRADE_MAILDROP ?? join(dir, 'maildrop'),
    mailAddress: process.env.AGENT_TRADE_MAIL_ADDRESS,
    mailPeer: process.env.AGENT_TRADE_MAIL_PEER,
    trackerPort: positiveInteger(process.env.AGENT_TRADE_TRACKER_PORT),
    wakeQueueDir: process.env.AGENT_TRADE_WAKE_QUEUE ?? join(dir, 'contact'),
    contactProvider,
    contactApiKeyEnv: process.env.AGENT_TRADE_CONTACT_API_KEY_ENV,
    contactInboxId: process.env.AGENT_TRADE_CONTACT_INBOX_ID,
    contactMaxMessageBytes: positiveInteger(process.env.AGENT_TRADE_CONTACT_MAX_MESSAGE_BYTES),
  });
}

function createServer(app: DshApp): McpServer {
  const server = new McpServer(
    { name: 'agent-native-trade', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  for (const spec of rawToolSpec.tools as ToolSpec[]) {
    const handler = DISPATCH[spec.name];
    if (handler === undefined) throw new Error(`missing handler for ${spec.name}`);
    server.registerTool(
      spec.name,
      {
        title: spec.name,
        description: spec.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(spec.parameters),
        annotations: { readOnlyHint: READ_ONLY.has(spec.name) },
      },
      async (args) => {
        const value = await handler(args, app);
        const result = wrapResult(value, SUMMARY_CAPS[spec.name]);
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          structuredContent: result,
        };
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  const app = createApp();
  if (app.localTracker !== undefined) {
    const tracker = await startTracker(app.localTracker);
    app.localTracker = tracker.port;
  }

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    app.close();
  };
  process.once('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(0);
  });
  process.once('exit', close);

  const server = createServer(app);
  serveStdio(() => server);
}

void main().catch((error: unknown) => {
  process.stderr.write(`agent-native-trade MCP fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
