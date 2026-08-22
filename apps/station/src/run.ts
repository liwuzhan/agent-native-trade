/**
 * @agent-trade/station — station daemon base and CLI role dispatch (module S1).
 *
 * `runStation` parses `station <role> --config <path>`, loads config, opens the
 * identity and M3 store, then starts the registered role (falling back to the
 * S1 stub when the role has no implementation yet). SIGINT/SIGTERM stop the
 * role and close the store.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openStore } from '@agent-trade/local-store';

import { loadConfig } from './config.js';
import { loadOrCreateSeed } from './identity.js';
import { createLogger } from './logger.js';
import { createStubRole } from './roles/stub.js';
import type { StationConfig, StationContext, StationRole, StationRoleName } from './types.js';

const ROLE_NAMES: readonly string[] = ['indexer', 'publisher', 'integrator'];

export interface CliArgs {
  role: StationRoleName;
  configPath: string;
}

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { config: { type: 'string' } },
  });
  const role = positionals[0];
  if (role === undefined) {
    throw new Error('usage: station <indexer|publisher|integrator> --config <path>');
  }
  if (!ROLE_NAMES.includes(role)) {
    throw new Error(`unknown role: ${JSON.stringify(role)} (expected indexer|publisher|integrator)`);
  }
  if (positionals.length > 1) {
    throw new Error(`unexpected positional arguments: ${positionals.slice(1).join(' ')}`);
  }
  const configPath = values.config;
  if (configPath === undefined) {
    throw new Error('--config <path> is required');
  }
  return { role: role as StationRoleName, configPath };
}

export function buildContext(config: StationConfig, secretKey: string, publicKey: string): StationContext {
  const dataDir = resolve(config.data_dir);
  const store = openStore(dataDir);
  const logger = createLogger(config.log);
  return {
    agentId: config.agent_id,
    publicKey,
    secretKey,
    config,
    dataDir,
    store,
    logger,
  };
}

export async function runStation(roleRegistry: Record<string, StationRole>, argv: string[]): Promise<void> {
  const { role, configPath } = parseCli(argv);
  const config = loadConfig(configPath);
  if (config.role !== role) {
    throw new Error(`role mismatch: CLI role ${JSON.stringify(role)} but config role ${JSON.stringify(config.role)}`);
  }

  const identity = loadOrCreateSeed(config.identity_seed_file);
  const ctx = buildContext(config, identity.secretKey, identity.publicKey);

  ctx.logger('info', 'station starting', {
    role,
    agentId: ctx.agentId,
    publicKey: ctx.publicKey,
    dataDir: ctx.dataDir,
    identitySeedFile: resolve(config.identity_seed_file),
    http: config.http,
  });

  const roleImpl = roleRegistry[role] ?? createStubRole(role);
  let started: { stop(): Promise<void> };
  try {
    started = await roleImpl.start(ctx);
  } catch (err) {
    try {
      ctx.store.close();
    } catch {
      /* ignore close failure on start error */
    }
    throw err;
  }

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      ctx.logger('info', 'shutdown requested', { signal });
      void (async () => {
        try {
          await started.stop();
        } catch (err) {
          ctx.logger('error', 'role stop failed', { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          ctx.store.close();
        } catch (err) {
          ctx.logger('error', 'store close failed', { error: err instanceof Error ? err.message : String(err) });
        }
        resolve();
      })();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}
