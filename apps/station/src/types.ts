/**
 * @agent-trade/station — shared types (module S1).
 */

import type { Store } from '@agent-trade/local-store';

/** The three roles S1–S4 dispatch to. */
export type StationRoleName = 'indexer' | 'publisher' | 'integrator';

export type LogLevel = 'info' | 'warn' | 'error';

export interface HttpConfig {
  host: string;
  port: number;
}

export interface LogConfig {
  level: LogLevel;
}

/**
 * Base configuration schema (module card S1). The per-role blocks
 * (`indexer` / `publisher` / `integrator`) are defined by each role; the base
 * validates only the shared fields and passes the role block through verbatim.
 */
export interface StationConfig {
  agent_id: string;
  identity_seed_file: string;
  data_dir: string;
  http: HttpConfig;
  log: LogConfig;
  role: StationRoleName;
  indexer?: Record<string, unknown>;
  publisher?: Record<string, unknown>;
  integrator?: Record<string, unknown>;
}

export interface StationContext {
  agentId: string;
  publicKey: string;
  secretKey: string;
  config: StationConfig;
  dataDir: string;
  store: Store;
  logger: (level: LogLevel, msg: string, extra?: object) => void;
}

export interface StationRole {
  name: string;
  start(ctx: StationContext): Promise<{ stop(): Promise<void> }>;
}
