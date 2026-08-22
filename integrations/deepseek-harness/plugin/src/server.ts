/**
 * server.ts — JSONL daemon 入口（DSH 插件 spawn 的子进程）。
 *
 * 协议见 contract.ts。启动：`node dist/server.js serve [flags]`
 *   --dir <d>           交易数据根（.data/ 所在；同 M9 AGENT_TRADE_DATA_DIR）
 *   --agent-id <id>     默认 actor（缺省 'agent'）
 *   --catalog-dir <d>   目录搜索根（缺省 <dir>/.data/catalog）
 *   --maildrop <d>      邮件 spool 根（缺省 <dir>/.data/maildrop）
 *   --mail-address <a>  本 daemon 收件地址（缺省 agent@trade.local）
 *   --mail-peer <a>     trade_contact_seller 默认收件方
 *   --tracker-port <n>  本地 BT tracker 端口（0 = 不启动）
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
import type { JsonRpcRequest, JsonRpcResponse } from './contract.js';
import { catalogGetItem, catalogSearch } from './handlers/catalog.js';
import { tradeContactSeller } from './handlers/contact.js';
import { humanTaskCancel, humanTaskComplete, humanTaskCreate, humanTaskList } from './handlers/human-task.js';
import { tradeBroadcastReceipt } from './handlers/broadcast.js';

type Handler = (args: Record<string, unknown>, app: DshApp) => Record<string, unknown> | Promise<Record<string, unknown>>;

const DISPATCH: Record<string, Handler> = {
  trade_identity_create: identityCreate as Handler,
  catalog_search: catalogSearch,
  catalog_get_item: catalogGetItem,
  trade_contact_seller: tradeContactSeller,
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
    process.stderr.write('usage: server.js serve [--dir <d>] [--agent-id <id>] [--catalog-dir <d>] [--maildrop <d>] [--mail-address <a>] [--mail-peer <a>] [--tracker-port <n>]\n');
    process.exit(2);
  }
  const dir = argOf(argv, '--dir') ?? process.cwd();
  const trackerPort = Number(argOf(argv, '--tracker-port') ?? '0');

  const app = createDshApp({
    dir,
    agentId: argOf(argv, '--agent-id'),
    catalogDir: argOf(argv, '--catalog-dir'),
    maildropDir: argOf(argv, '--maildrop'),
    mailAddress: argOf(argv, '--mail-address'),
    mailPeer: argOf(argv, '--mail-peer'),
    trackerPort: Number.isInteger(trackerPort) && trackerPort > 0 ? trackerPort : undefined,
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
        respond({ id: request.id, ok: true, result: wrapResult(value) });
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
