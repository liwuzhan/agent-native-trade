/**
 * S1 acceptance 1 (CLI parsing): `station <role> --config <path>` argument
 * validation — missing role/--config and unknown role all error.
 */

import { describe, expect, it } from 'vitest';

import { parseCli } from '../src/run.js';

describe('parseCli', () => {
  it('parses a valid role and --config', () => {
    const args = parseCli(['indexer', '--config', './station.yaml']);
    expect(args).toEqual({ role: 'indexer', configPath: './station.yaml' });
  });

  it('accepts every role', () => {
    for (const role of ['indexer', 'publisher', 'integrator'] as const) {
      expect(parseCli([role, '--config', 'c.yaml']).role).toBe(role);
    }
  });

  it('errors when the role is missing', () => {
    expect(() => parseCli(['--config', 'c.yaml'])).toThrow(/usage: station/);
  });

  it('errors on an unknown role', () => {
    expect(() => parseCli(['broker', '--config', 'c.yaml'])).toThrow(/unknown role: "broker"/);
  });

  it('errors when --config is missing', () => {
    expect(() => parseCli(['indexer'])).toThrow(/--config <path> is required/);
  });
});
