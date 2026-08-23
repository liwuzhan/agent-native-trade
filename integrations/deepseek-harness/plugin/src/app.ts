/**
 * app.ts — DshApp：DSH daemon 的状态核心。一个 daemon 进程一个实例。
 *
 * 在 M9 的 TradeApp（store / policy / keys / settlement 适配器）之上叠加：
 * - resolveKey 扩展：信任环 = .data/keys/（本地私钥派生）+ .data/peers/<agentId>.pub
 *   （只读公钥导入；私钥永不离开本机 —— 公钥不是秘密，红线只约束私钥）；
 * - humanTasks：M7 文件化 human-task store（.data/tasks/，可单测）；
 * - mail：M5 邮件适配器（file-maildrop loopback；生产换 SMTP/IMAP URL）；
 * - contact：联系 provider（agentmail REST / maildrop loopback）——contact_* 工具后端；
 * - wakeQueue：trade-inboxd 写入的 WakeTask 队列（FileWakeQueue，pending/ + done/）；
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
import { FileWakeQueue } from '@agent-trade/contact-core';
import type { ContactAdapter } from '@agent-trade/contact-core';

import { createContactAdapter } from './contact/provider.js';
import type { ContactProviderKind } from './contact/provider.js';
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
  /** WakeTask 队列根（trade-inboxd 的 dataDir：pending/ + done/）；缺省 <dir>/.data/contact。 */
  wakeQueueDir?: string;
  /** 联系 provider：agentmail（真实邮箱 REST）或 maildrop（本地 loopback，缺省）。 */
  contactProvider?: ContactProviderKind;
  /** agentmail：apiKey 所在环境变量名（缺省 AGENTMAIL_API_KEY）。 */
  contactApiKeyEnv?: string;
  /** agentmail：本 daemon inbox；maildrop：收件地址（缺省同 mailAddress）。 */
  contactInboxId?: string;
  /** 单封邮件大小门限（agentmail REST 响应上限）。 */
  contactMaxMessageBytes?: number;
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
  /** 联系 provider（agentmail REST / maildrop loopback）——contact_* 工具后端。 */
  contact: ContactAdapter;
  /** 联系 provider 种类（contact_* 工具与 wake 过滤共用）。 */
  contactProvider: ContactProviderKind;
  /** 本 daemon 的联系 inbox（wake 列表过滤键；agentmail=inboxId，maildrop=收件地址）。 */
  contactInboxId: string;
  /** trade-inboxd 写入的 WakeTask 队列（pending/ + done/）。 */
  wakeQueue: FileWakeQueue;
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

  const contactProvider: ContactProviderKind = opts.contactProvider ?? 'maildrop';
  const contactInboxId = opts.contactInboxId ?? mailAddress;
  const contact = createContactAdapter({
    provider: contactProvider,
    apiKeyEnv: opts.contactApiKeyEnv,
    inboxId: contactInboxId,
    maxMessageBytes: opts.contactMaxMessageBytes,
    spoolRoot: maildropDir,
    fromAddress: mailAddress,
  });
  const wakeQueue = new FileWakeQueue(opts.wakeQueueDir ?? join(opts.dir, '.data', 'contact'));

  const app: DshApp = {
    ...base,
    catalogDir: opts.catalogDir ?? join(opts.dir, '.data', 'catalog'),
    mail,
    humanTasks: createHumanTaskStore(base.store, { dir: opts.dir }),
    mailAddress,
    mailPeer: opts.mailPeer,
    localTracker: opts.trackerPort && opts.trackerPort > 0 ? opts.trackerPort : undefined,
    seeds,
    contact,
    contactProvider,
    contactInboxId,
    wakeQueue,
    // 信任环：本地私钥派生 + 只读公钥导入（peers/）
    resolveKey(signer: string): string | undefined {
      return base.resolveKey(signer) ?? readPeerKey(peerDir, signer);
    },
    close(): void {
      base.close();
      void mail.close();
      void contact.close();
      for (const stop of seeds.values()) void stop().catch(() => undefined);
      seeds.clear();
    },
  };
  return app;
}
