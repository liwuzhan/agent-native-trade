/**
 * app.ts — DshApp：DSH daemon 的状态核心。一个 daemon 进程一个实例。
 *
 * 在 M9 的 TradeApp（store / policy / keys / settlement 适配器）之上叠加：
 * - resolveKey 扩展：信任环 = .data/keys/（本地私钥派生）+ .data/peers/<agentId>.pub
 *   （只读公钥导入；私钥永不离开本机 —— 公钥不是秘密，红线只约束私钥）；
 * - humanTasks：M7 文件化 human-task store（.data/tasks/，可单测）；
 * - mail：M5 邮件适配器（file-maildrop loopback；生产换 SMTP/IMAP URL）；
 * - catalogDir / mailAddress / mailPeer / localTracker / seeds：M10 专属配置。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMailAdapter } from '@agent-trade/email';
import type { MailAdapter } from '@agent-trade/email';
import { createHumanTaskStore } from '@agent-trade/human-task';
import type { HumanTaskStore } from '@agent-trade/human-task';
import { createTradeApp } from '@agent-trade/mcp-server/app';
import type { TradeApp } from '@agent-trade/mcp-server/app';

import { FileMailboxSource, FileSendTransport } from './maildrop.js';

export interface DshAppOptions {
  /** 根目录（同 M9 openStore 约定）：含 .data/（objects/keys/index.sqlite/policy.json）。 */
  dir: string;
  /** 默认 actor；工具不显式指定时用它。 */
  agentId?: string;
  /** 目录搜索根（<item_id>.json + <item_id>.listing-ref.json）。 */
  catalogDir?: string;
  /** 邮件 spool 根（file-maildrop）；缺省 <dir>/.data/maildrop/。 */
  maildropDir?: string;
  /** 本 daemon 的收件地址（如 buyer@trade.local）。 */
  mailAddress?: string;
  /** trade_contact_seller 的默认收件方（如 seller@trade.local）。 */
  mailPeer?: string;
  /** 本地 tracker 端口（0/缺省 = 不启动）。 */
  trackerPort?: number;
}

export interface DshApp extends TradeApp {
  catalogDir: string;
  mail: MailAdapter;
  humanTasks: HumanTaskStore;
  mailAddress: string;
  mailPeer: string | undefined;
  /** 本地 tracker 端口（broadcast 的 announce URL）；未启动时为 undefined。 */
  localTracker: number | undefined;
  /** 做种句柄：object_id → stop()。daemon 关闭时统一停止。 */
  seeds: Map<string, () => Promise<void>>;
}

function readPeerKey(peerDir: string, agentId: string): string | undefined {
  const path = join(peerDir, `${agentId}.pub`);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  // 43 字符 base64url（无填充）：32 字节 Ed25519 公钥
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
  return text;
}

export function createDshApp(opts: DshAppOptions): DshApp {
  const base = createTradeApp({ dir: opts.dir, agentId: opts.agentId ?? 'agent' });
  const peerDir = join(opts.dir, '.data', 'peers');
  mkdirSync(peerDir, { recursive: true });

  const maildropDir = opts.maildropDir ?? join(opts.dir, '.data', 'maildrop');
  const mailAddress = opts.mailAddress ?? 'agent@trade.local';
  const mail = createMailAdapter(
    {
      // 发件人取自 smtpUrl 的 user 段（M5 adapter 的 #from 派生规则）
      smtpUrl: `smtp://${mailAddress}@localhost:25`,
      imapUrl: `imap://${mailAddress}@localhost:143`,
      inboxDir: join(opts.dir, '.data', 'mail-inbox'),
      seenStorePath: join(opts.dir, '.data', 'mail-seen.json'),
    },
    {
      source: new FileMailboxSource(maildropDir, mailAddress),
      transport: new FileSendTransport(maildropDir, mailAddress),
    },
  );

  const seeds = new Map<string, () => Promise<void>>();

  const app: DshApp = {
    ...base,
    catalogDir: opts.catalogDir ?? join(opts.dir, '.data', 'catalog'),
    mail,
    humanTasks: createHumanTaskStore(base.store, { dir: opts.dir }),
    mailAddress,
    mailPeer: opts.mailPeer,
    localTracker: opts.trackerPort && opts.trackerPort > 0 ? opts.trackerPort : undefined,
    seeds,
    // 信任环：本地私钥派生 + 只读公钥导入（peers/）
    resolveKey(signer: string): string | undefined {
      return base.resolveKey(signer) ?? readPeerKey(peerDir, signer);
    },
    close(): void {
      base.close();
      void mail.close();
      for (const stop of seeds.values()) void stop().catch(() => undefined);
      seeds.clear();
    },
  };
  return app;
}
