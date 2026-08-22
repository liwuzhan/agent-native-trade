/**
 * S1 acceptance 1 & 3: config load (YAML/JSON), validation with field names,
 * and `STATION_`-prefixed env overrides.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig } from '../src/config.js';

const OVERRIDES = new Set<string>();

function setEnv(name: string, value: string): void {
  process.env[name] = value;
  OVERRIDES.add(name);
}

function clearEnv(): void {
  for (const key of OVERRIDES) delete process.env[key];
  OVERRIDES.clear();
}

function write(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

const BASE_YAML = [
  'agent_id: station-indexer-01',
  'identity_seed_file: ./seed.key',
  'data_dir: .data',
  'http: { host: 0.0.0.0, port: 8780 }',
  'log: { level: info }',
  'role: indexer',
].join('\n') + '\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-config-'));
});

afterEach(() => {
  clearEnv();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig: YAML / JSON', () => {
  it('loads a YAML config', () => {
    const path = write(dir, 'station.yaml', BASE_YAML);
    const config = loadConfig(path);
    expect(config.agent_id).toBe('station-indexer-01');
    expect(config.identity_seed_file).toBe('./seed.key');
    expect(config.data_dir).toBe('.data');
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8780 });
    expect(config.log).toEqual({ level: 'info' });
    expect(config.role).toBe('indexer');
  });

  it('loads a JSON config', () => {
    const path = write(
      dir,
      'station.json',
      JSON.stringify({ agent_id: 'a', identity_seed_file: './s', data_dir: './d', http: { host: '127.0.0.1', port: 9000 }, log: { level: 'warn' }, role: 'publisher' }),
    );
    const config = loadConfig(path);
    expect(config.agent_id).toBe('a');
    expect(config.http.port).toBe(9000);
    expect(config.role).toBe('publisher');
  });

  it('passes per-role blocks through verbatim', () => {
    const path = write(dir, 'station.yaml', BASE_YAML + 'indexer:\n  weights_file: w.json\n  mirror_catalogs: true\n');
    const config = loadConfig(path);
    expect(config.indexer).toEqual({ weights_file: 'w.json', mirror_catalogs: true });
  });
});

describe('loadConfig: validation errors carry field names', () => {
  it('reports a missing file', () => {
    expect(() => loadConfig(join(dir, 'nope.yaml'))).toThrow(/cannot read/);
  });

  it('reports a type error with the field name', () => {
    const path = write(dir, 'station.yaml', BASE_YAML.replace('port: 8780', 'port: "8780"'));
    expect(() => loadConfig(path)).toThrow('http.port: expected number, got string');
  });

  it('reports a missing required field', () => {
    const path = write(dir, 'station.yaml', BASE_YAML.replace('agent_id: station-indexer-01\n', ''));
    expect(() => loadConfig(path)).toThrow('agent_id: expected string, got undefined');
  });

  it('reports an invalid role', () => {
    const path = write(dir, 'station.yaml', BASE_YAML.replace('role: indexer', 'role: broker'));
    expect(() => loadConfig(path)).toThrow(/role: invalid value "broker"/);
  });

  it('reports an invalid log level', () => {
    const path = write(dir, 'station.yaml', BASE_YAML.replace('level: info', 'level: debug'));
    expect(() => loadConfig(path)).toThrow(/log\.level: invalid value "debug"/);
  });

  it('throws ConfigError for invalid config', () => {
    const path = write(dir, 'station.yaml', BASE_YAML.replace('port: 8780', 'port: "8780"'));
    let caught: unknown;
    try {
      loadConfig(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
  });
});

describe('loadConfig: STATION_ env overrides', () => {
  it('overrides http.port via STATION_HTTP_PORT', () => {
    setEnv('STATION_HTTP_PORT', '9000');
    const config = loadConfig(write(dir, 'station.yaml', BASE_YAML));
    expect(config.http.port).toBe(9000);
  });

  it('overrides agent_id via STATION_AGENT_ID (snake_case leaf key)', () => {
    setEnv('STATION_AGENT_ID', 'override-agent');
    const config = loadConfig(write(dir, 'station.yaml', BASE_YAML));
    expect(config.agent_id).toBe('override-agent');
  });

  it('overrides nested host via STATION_HTTP_HOST', () => {
    setEnv('STATION_HTTP_HOST', '127.0.0.1');
    const config = loadConfig(write(dir, 'station.yaml', BASE_YAML));
    expect(config.http.host).toBe('127.0.0.1');
  });

  it('reports a field name when an env numeric override is non-numeric', () => {
    setEnv('STATION_HTTP_PORT', 'abc');
    expect(() => loadConfig(write(dir, 'station.yaml', BASE_YAML))).toThrow('http.port: expected number');
  });
});
