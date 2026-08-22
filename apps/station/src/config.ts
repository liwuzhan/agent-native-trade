/**
 * @agent-trade/station — configuration loading (module S1).
 *
 * YAML or JSON + `STATION_`-prefixed environment overrides + validation that
 * always reports the offending field name. Per-role blocks are passed through
 * unvalidated (each role owns its own schema).
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import type { StationConfig, StationRoleName } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ROLE_NAMES: readonly string[] = ['indexer', 'publisher', 'integrator'];
const LOG_LEVELS: readonly string[] = ['info', 'warn', 'error'];

/** Top-level keys that hold objects; used to disambiguate nested env paths. */
const OBJECT_KEYS = new Set(['http', 'log', 'indexer', 'publisher', 'integrator']);
/** Top-level scalar keys (which may themselves contain underscores); matched whole. */
const LEAF_KEYS = new Set(['agent_id', 'identity_seed_file', 'data_dir', 'role']);

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new ConfigError(`${field}: ${message}`);
}

function requireString(obj: Record<string, unknown>, key: string, field: string = key): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    fail(field, `expected string, got ${typeName(value)}`);
  }
  if (value.length === 0) {
    fail(field, 'expected non-empty string');
  }
  return value;
}

function requirePort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, `expected number, got ${typeName(value)}`);
  }
  if (!Number.isInteger(value)) {
    fail(field, `expected integer, got ${value}`);
  }
  if (value < 0 || value > 65535) {
    fail(field, `expected port in range 0..65535, got ${value}`);
  }
  return value;
}

function validateConfig(raw: Record<string, unknown>): StationConfig {
  const agentId = requireString(raw, 'agent_id');
  const identitySeedFile = requireString(raw, 'identity_seed_file');
  const dataDir = requireString(raw, 'data_dir');

  const http = raw['http'];
  if (!isPlainObject(http)) {
    fail('http', `expected object, got ${typeName(http)}`);
  }
  const host = requireString(http, 'host', 'http.host');
  const port = requirePort(http['port'], 'http.port');

  const log = raw['log'];
  if (!isPlainObject(log)) {
    fail('log', `expected object, got ${typeName(log)}`);
  }
  const level = requireString(log, 'level', 'log.level');
  if (!LOG_LEVELS.includes(level)) {
    fail('log.level', `invalid value ${JSON.stringify(level)} (expected info|warn|error)`);
  }

  const role = requireString(raw, 'role');
  if (!ROLE_NAMES.includes(role)) {
    fail('role', `invalid value ${JSON.stringify(role)} (expected indexer|publisher|integrator)`);
  }

  const config: StationConfig = {
    agent_id: agentId,
    identity_seed_file: identitySeedFile,
    data_dir: dataDir,
    http: { host, port },
    log: { level: level as StationConfig['log']['level'] },
    role: role as StationRoleName,
  };
  for (const key of ['indexer', 'publisher', 'integrator'] as const) {
    const block = raw[key];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      fail(key, `expected object, got ${typeName(block)}`);
    }
    config[key] = block;
  }
  return config;
}

/** Map a `STATION_*` env name to a dotted config path (e.g. HTTP_PORT → ['http','port']). */
function envPath(name: string): string[] | null {
  if (!name.startsWith('STATION_')) return null;
  const rest = name.slice('STATION_'.length).toLowerCase();
  if (LEAF_KEYS.has(rest)) return [rest];
  if (OBJECT_KEYS.has(rest)) return [rest];
  for (const key of OBJECT_KEYS) {
    if (rest.startsWith(key + '_')) {
      return [key, ...rest.slice(key.length + 1).split('_')];
    }
  }
  return rest.split('_');
}

function getAt(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setAt(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const next = current[segment];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else {
      current = next;
    }
  }
  current[path[path.length - 1]!] = value;
}

/** Coerce an env string to the type of the value it overrides (number/bool/array/object). */
function coerceEnvValue(path: string[], existing: unknown, raw: string): unknown {
  const field = path.join('.');
  if (typeof existing === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      fail(field, `expected number, got string ${JSON.stringify(raw)}`);
    }
    return value;
  }
  if (typeof existing === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    fail(field, `expected boolean, got string ${JSON.stringify(raw)}`);
  }
  if (Array.isArray(existing)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* fall through to comma-split */
      }
    }
    return trimmed.length === 0 ? [] : trimmed.split(',');
  }
  if (isPlainObject(existing)) {
    try {
      return JSON.parse(raw);
    } catch {
      fail(field, `expected object (JSON), got string ${JSON.stringify(raw)}`);
    }
  }
  return raw;
}

function applyEnvOverrides(config: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(process.env)) {
    if (raw === undefined || raw === '') continue;
    const path = envPath(name);
    if (path === null || path.length === 0) continue;
    const existing = getAt(config, path);
    setAt(config, path, coerceEnvValue(path, existing, raw));
  }
}

export function loadConfig(path: string): StationConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`config: cannot read ${JSON.stringify(path)}: ${cause}`);
  }

  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`config: cannot parse ${JSON.stringify(path)}: ${cause}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`config: expected a mapping at the root of ${JSON.stringify(path)}`);
  }

  applyEnvOverrides(parsed);
  return validateConfig(parsed);
}
