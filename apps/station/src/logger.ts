/**
 * @agent-trade/station — JSON-lines logger to stdout (module S1).
 */

import type { LogConfig, LogLevel } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

export type Logger = (level: LogLevel, msg: string, extra?: object) => void;

export function createLogger(config: LogConfig): Logger {
  const threshold = LEVEL_ORDER[config.level];
  return (level, msg, extra) => {
    if (LEVEL_ORDER[level] > threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    };
    process.stdout.write(JSON.stringify(record) + '\n');
  };
}
