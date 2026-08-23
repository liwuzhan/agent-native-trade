import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnqueueResult } from '@agent-trade/contact-core';
import type { TriggerConfig } from './config.js';

const execFileAsync = promisify(execFile);

export interface WakeTrigger {
  notify(result: EnqueueResult): Promise<void>;
}

export class NoopWakeTrigger implements WakeTrigger {
  async notify(_result: EnqueueResult): Promise<void> {}
}

export class CommandWakeTrigger implements WakeTrigger {
  private tail = Promise.resolve();

  constructor(private readonly config: Extract<TriggerConfig, { mode: 'command' }>) {}

  notify(result: EnqueueResult): Promise<void> {
    const run = this.tail.then(async () => {
      const [executable, ...rawArgs] = this.config.argv;
      if (!executable) throw new Error('command trigger executable is missing');
      const args = rawArgs.map((part) => part
        .replaceAll('{task}', result.path)
        .replaceAll('{task_id}', result.task.task_id));
      await execFileAsync(executable, args, {
        cwd: this.config.cwd,
        env: {
          ...process.env,
          AGENT_TRADE_WAKE_TASK: result.path,
          AGENT_TRADE_WAKE_TASK_ID: result.task.task_id,
        },
        shell: false,
        timeout: this.config.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export function createWakeTrigger(config: TriggerConfig): WakeTrigger {
  return config.mode === 'command' ? new CommandWakeTrigger(config) : new NoopWakeTrigger();
}
