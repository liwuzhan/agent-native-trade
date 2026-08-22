/**
 * @agent-trade/station — station skeleton, config, CLI and role dispatch
 * (module S1).
 */

export type {
  StationConfig,
  StationContext,
  StationRole,
  StationRoleName,
  LogLevel,
  HttpConfig,
  LogConfig,
} from './types.js';

export { loadConfig, ConfigError } from './config.js';
export { runStation, parseCli, buildContext } from './run.js';
export type { CliArgs } from './run.js';
export { createStubRole } from './roles/stub.js';
export type { StubHandle } from './roles/stub.js';
export { loadOrCreateSeed } from './identity.js';
export type { IdentityResult } from './identity.js';
export { createLogger } from './logger.js';
export type { Logger } from './logger.js';
