#!/usr/bin/env node
import { createAgentMailAdapter } from '@agent-trade/contact-agentmail';
import { FileWakeQueue } from '@agent-trade/contact-core';
import { loadInboxdConfig } from './config.js';
import { TradeInboxDaemon } from './daemon.js';
import { createWakeTrigger } from './trigger.js';

function usage(): never {
  console.error('Usage: trade-inboxd <run|doctor|list|ack> --config <path> [task-id]');
  process.exitCode = 2;
  throw new Error('invalid command line');
}

function argumentsFrom(argv: string[]): { command: string; configPath: string; taskId?: string } {
  const [command, ...rest] = argv;
  if (!command) return usage();
  const configIndex = rest.indexOf('--config');
  if (configIndex < 0 || !rest[configIndex + 1]) return usage();
  const positional = rest.filter((_value, index) => index !== configIndex && index !== configIndex + 1);
  return { command, configPath: rest[configIndex + 1] as string, ...(positional[0] ? { taskId: positional[0] } : {}) };
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const config = await loadInboxdConfig(args.configPath);
  const queue = new FileWakeQueue(config.dataDir);

  if (args.command === 'list') {
    json(await queue.listPending());
    return;
  }
  if (args.command === 'ack') {
    if (!args.taskId) return usage();
    json({ task_id: args.taskId, path: await queue.ack(args.taskId) });
    return;
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`required environment variable is missing: ${config.apiKeyEnv}`);
  const adapter = createAgentMailAdapter({
    apiKey,
    inboxId: config.inboxId,
    maxMessageBytes: config.maxMessageBytes,
  });

  if (args.command === 'doctor') {
    const health = await adapter.health();
    json(health);
    await adapter.close();
    if (!health.ok) process.exitCode = 1;
    return;
  }
  if (args.command !== 'run') return usage();

  const daemon = new TradeInboxDaemon({
    adapter,
    queue,
    trigger: createWakeTrigger(config.trigger),
    inboxId: config.inboxId,
    reconnectInitialMs: config.reconnect.initialMs,
    reconnectMaxMs: config.reconnect.maxMs,
    logger: json,
  });
  const stop = (): void => { void daemon.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await daemon.run();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
