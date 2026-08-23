import type { ContactAdapter, InboundEvent, WatchHandle } from '@agent-trade/contact-core';
import { FileWakeQueue } from '@agent-trade/contact-core';
import type { WakeTrigger } from './trigger.js';

export interface InboxdLogRecord {
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

export type InboxdLogger = (record: InboxdLogRecord) => void;

export interface TradeInboxDaemonOptions {
  adapter: ContactAdapter;
  queue: FileWakeQueue;
  trigger: WakeTrigger;
  inboxId: string;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  logger?: InboxdLogger;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export class TradeInboxDaemon {
  private readonly abort = new AbortController();
  private activeWatcher: WatchHandle | undefined;
  private readonly logger: InboxdLogger;
  private readonly activeTriggers = new Set<Promise<void>>();
  private running = false;

  constructor(private readonly options: TradeInboxDaemonOptions) {
    this.logger = options.logger ?? (() => undefined);
  }

  async run(): Promise<void> {
    if (this.running) throw new Error('trade-inboxd is already running');
    this.running = true;
    await this.options.queue.init();
    let backoff = this.options.reconnectInitialMs ?? 1_000;
    const maxBackoff = this.options.reconnectMaxMs ?? 30_000;

    try {
      while (!this.abort.signal.aborted) {
        try {
          this.activeWatcher = await this.options.adapter.watch(
            { inboxIds: [this.options.inboxId], eventTypes: ['message.received'] },
            (event) => this.receive(event),
          );
          this.logger({ level: 'info', event: 'contact.watch.connected', provider: 'agentmail' });
          backoff = this.options.reconnectInitialMs ?? 1_000;
          await this.activeWatcher.done;
          if (!this.abort.signal.aborted) throw new Error('contact watch ended');
        } catch (error) {
          if (this.abort.signal.aborted) break;
          this.logger({
            level: 'warn',
            event: 'contact.watch.disconnected',
            retryMs: backoff,
            error: error instanceof Error ? error.message : String(error),
          });
          await delay(backoff, this.abort.signal);
          backoff = Math.min(maxBackoff, backoff * 2);
        } finally {
          this.activeWatcher = undefined;
        }
      }
    } finally {
      this.running = false;
      await this.options.adapter.close();
      await Promise.allSettled([...this.activeTriggers]);
      this.logger({ level: 'info', event: 'contact.watch.stopped' });
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.activeWatcher?.close();
  }

  private async receive(event: InboundEvent): Promise<void> {
    const result = await this.options.queue.enqueue(event);
    if (!result.accepted) {
      this.logger({
        level: 'info',
        event: 'wake_task.duplicate',
        taskId: result.task.task_id,
        messageId: result.task.message_ref.message_id,
      });
      return;
    }

    this.logger({
      level: 'info',
      event: 'wake_task.queued',
      taskId: result.task.task_id,
      messageId: result.task.message_ref.message_id,
      tradeId: result.task.trade_id,
    });
    const trigger = this.options.trigger.notify(result).then(() => {
      this.logger({ level: 'info', event: 'wake_task.triggered', taskId: result.task.task_id });
    }).catch((error: unknown) => {
      this.logger({
        level: 'error',
        event: 'wake_task.trigger_failed',
        taskId: result.task.task_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.activeTriggers.delete(trigger);
    });
    this.activeTriggers.add(trigger);
  }
}
