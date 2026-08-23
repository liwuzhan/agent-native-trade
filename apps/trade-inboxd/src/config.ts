import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface NoTriggerConfig {
  mode: 'none';
}

export interface CommandTriggerConfig {
  mode: 'command';
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
}

export type TriggerConfig = NoTriggerConfig | CommandTriggerConfig;

export interface InboxdConfig {
  provider: 'agentmail';
  inboxId: string;
  apiKeyEnv: string;
  dataDir: string;
  maxMessageBytes: number;
  reconnect: {
    initialMs: number;
    maxMs: number;
  };
  trigger: TriggerConfig;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function parseInboxdConfig(value: unknown, baseDir = process.cwd()): InboxdConfig {
  const source = object(value, 'config');
  if (source.provider !== 'agentmail') throw new Error('config.provider must be agentmail');
  const apiKeyEnv = string(source.apiKeyEnv, 'config.apiKeyEnv');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) throw new Error('config.apiKeyEnv is not a valid environment variable name');

  const reconnectSource = source.reconnect === undefined ? {} : object(source.reconnect, 'config.reconnect');
  const initialMs = positiveInteger(reconnectSource.initialMs, 1_000, 'config.reconnect.initialMs');
  const maxMs = positiveInteger(reconnectSource.maxMs, 30_000, 'config.reconnect.maxMs');
  if (initialMs > maxMs) throw new Error('config.reconnect.initialMs must not exceed maxMs');

  const rawTrigger = source.trigger === undefined ? { mode: 'none' } : object(source.trigger, 'config.trigger');
  let trigger: TriggerConfig;
  if (rawTrigger.mode === 'none') {
    trigger = { mode: 'none' };
  } else if (rawTrigger.mode === 'command') {
    if (!Array.isArray(rawTrigger.argv) || rawTrigger.argv.length === 0
      || rawTrigger.argv.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error('config.trigger.argv must be a non-empty string array');
    }
    trigger = {
      mode: 'command',
      argv: rawTrigger.argv as string[],
      ...(rawTrigger.cwd === undefined
        ? {}
        : { cwd: resolveFrom(baseDir, string(rawTrigger.cwd, 'config.trigger.cwd')) }),
      timeoutMs: positiveInteger(rawTrigger.timeoutMs, 300_000, 'config.trigger.timeoutMs'),
    };
  } else {
    throw new Error('config.trigger.mode must be none or command');
  }

  return {
    provider: 'agentmail',
    inboxId: string(source.inboxId, 'config.inboxId'),
    apiKeyEnv,
    dataDir: resolveFrom(baseDir, string(source.dataDir ?? '.agent-trade/contact', 'config.dataDir')),
    maxMessageBytes: positiveInteger(source.maxMessageBytes, 10 * 1024 * 1024, 'config.maxMessageBytes'),
    reconnect: { initialMs, maxMs },
    trigger,
  };
}

export async function loadInboxdConfig(path: string): Promise<InboxdConfig> {
  const absolutePath = resolve(path);
  const raw = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  return parseInboxdConfig(raw, dirname(absolutePath));
}
