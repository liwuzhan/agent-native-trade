/**
 * server.ts — JSONL daemon 入口（DSH 插件 spawn 的子进程）。
 *
 * 协议见 contract.ts。启动：`node dist/server.js serve [flags]`
 *   --dir <d>           交易数据根（.data/ 所在；同 M9 AGENT_TRADE_DATA_DIR）
 *   --agent-id <id>     默认 actor（缺省 'agent'）
 *   --catalog-dir <d>   目录搜索根（缺省 <dir>/.data/catalog）
 *   --indexers <csv>    远程 indexer 基址（缺省 https://deepcrop.site；空字符串禁用）
 *   --maildrop <d>      邮件 spool 根（缺省 <dir>/.data/maildrop）
 *   --mail-address <a>  本 daemon 收件地址（缺省 agent@trade.local）
 *   --mail-peer <a>     trade_contact_seller 默认收件方
 *   --tracker-port <n>  本地 BT tracker 端口（0 = 不启动）
 *   --wake-queue <d>    WakeTask 队列根（trade-inboxd dataDir；缺省 <dir>/.data/contact）
 *   --contact-provider <agentmail|maildrop>  联系 provider（缺省 maildrop）
 *   --contact-api-key-env <name>  agentmail apiKey 环境变量名（缺省 AGENTMAIL_API_KEY）
 *   --contact-inbox-id <id>  本 daemon 联系 inbox（缺省同 --mail-address）
 *   --contact-max-message-bytes <n>  单封邮件大小门限
 *
 * 启动完成后输出 {"event":"ready"}；收到 SIGTERM/SIGINT 时关闭并退出。
 */

import { createInterface } from 'node:readline';

import { startTracker } from '@agent-trade/bt-catalog';
import { identityCreate } from '@agent-trade/mcp-server/handlers/identity';
import { compileDeal, signDeal, verifyDeal } from '@agent-trade/mcp-server/handlers/deal';
import { getStatus, recordEvent } from '@agent-trade/mcp-server/handlers/event';
import { createReceipt, verifyReceipt } from '@agent-trade/mcp-server/handlers/receipt';
import { settlementConfirm, settlementRequest } from '@agent-trade/mcp-server/handlers/settlement';

import { createDshApp } from './app.js';
import type { DshApp } from './app.js';
import { isPlainObject, wrapError, wrapResult } from './contract.js';
import { parseIndexerUrls } from './indexers.js';
import type { JsonRpcRequest, JsonRpcResponse } from './contract.js';
import { catalogGetItem, catalogSearch } from './handlers/catalog.js';
import { contactMessageGet, contactReply, contactSend, tradeContactSeller } from './handlers/contact.js';
import { humanTaskCancel, humanTaskComplete, humanTaskCreate, humanTaskList } from './handlers/human-task.js';
import { tradeBroadcastReceipt } from './handlers/broadcast.js';
import { contactWakeAck, contactWakeList } from './handlers/wake.js';

type Handler = (args: Record<string, unknown>, app: DshApp) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * 工具级 summary 上限（字符数）。缺省 = contract 的 MAX_RESPONSE_CHARS（500）。
 * contact bridge 例外（按 bridge contract 允许正文进入上下文的有界路径）：
 *   contact_message_get：正文已被 BODY_TEXT_CAP(64 KiB) 截断 + 元数据余量；
 *   contact_wake_list：≤20 个小信封（无正文），有界。
 */
const SUMMARY_CAPS: Record<string, number> = {
  contact_message_get: 96 * 1024,
  contact_wake_list: 16 * 1024,
};

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

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'serve') {
    process.stderr.write(
      'usage: server.js serve [--dir <d>] [--agent-id <id>] [--catalog-dir <d>] [--indexers <csv>] [--maildrop <d>] [--mail-address <a>] [--mail-peer <a>] [--tracker-port <n>] [--wake-queue <d>] [--contact-provider <agentmail|maildrop>] [--contact-api-key-env <name>] [--contact-inbox-id <id>] [--contact-max-message-bytes <n>]\n',
    );
    process.exit(2);
  }
  const dir = argOf(argv, '--dir') ?? process.cwd();
  const trackerPort = Number(argOf(argv, '--tracker-port') ?? '0');
  const contactProvider = argOf(argv, '--contact-provider') ?? 'maildrop';
  if (contactProvider !== 'agentmail' && contactProvider !== 'maildrop') {
    process.stderr.write('--contact-provider must be agentmail or maildrop\n');
    process.exit(2);
  }
  const contactMaxMessageBytes = Number(argOf(argv, '--contact-max-message-bytes') ?? '0');

  const app = createDshApp({
    dir,
    agentId: argOf(argv, '--agent-id'),
    catalogDir: argOf(argv, '--catalog-dir'),
    indexerUrls: parseIndexerUrls(argOf(argv, '--indexers')),
    maildropDir: argOf(argv, '--maildrop'),
    mailAddress: argOf(argv, '--mail-address'),
    mailPeer: argOf(argv, '--mail-peer'),
    trackerPort: Number.isInteger(trackerPort) && trackerPort > 0 ? trackerPort : undefined,
    wakeQueueDir: argOf(argv, '--wake-queue'),
    contactProvider: contactProvider as 'agentmail' | 'maildrop',
    contactApiKeyEnv: argOf(argv, '--contact-api-key-env'),
    contactInboxId: argOf(argv, '--contact-inbox-id'),
    contactMaxMessageBytes:
      Number.isInteger(contactMaxMessageBytes) && contactMaxMessageBytes > 0 ? contactMaxMessageBytes : undefined,
  });

  if (app.localTracker !== undefined) {
    const tracker = await startTracker(app.localTracker);
    app.localTracker = tracker.port;
  }

  const respond = (response: JsonRpcResponse): void => {
    process.stdout.write(JSON.stringify(response) + '\n');
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void (async () => {
      let request: JsonRpcRequest;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isPlainObject(parsed) || typeof parsed.id !== 'string' || typeof parsed.tool !== 'string') {
          throw new Error('malformed request: expected {id, tool, args}');
        }
        request = parsed as unknown as JsonRpcRequest;
      } catch (error) {
        respond({ id: '', ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
        return;
      }

      const handler = DISPATCH[request.tool];
      if (handler === undefined) {
        respond({ id: request.id, ok: false, error: { message: `unknown tool: ${request.tool}` } });
        return;
      }
      const args = isPlainObject(request.args) ? request.args : {};
      try {
        const value = await handler(args, app);
        respond({ id: request.id, ok: true, result: wrapResult(value, SUMMARY_CAPS[request.tool]) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respond({ id: request.id, ok: false, error: { message } });
      }
    })();
  });

  const shutdown = (): void => {
    app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`daemon fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
