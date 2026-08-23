/**
 * @agent-trade/station — integrator config parsing (module S4).
 *
 * Validates the `integrator` role block with field names in every error, in the
 * same style as the S1 base config loader and the S3 publisher config parser.
 */

import type { IntegratorConfig } from './types.js';

const DEFAULT_ANNOUNCE_TIMEOUT_MS = 5000;
const DEFAULT_ANNOUNCE_RETRIES = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new Error(`integrator.${field}: ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(field, 'expected a non-empty string');
  }
  return value;
}

/** Required array of strings (may be empty). */
function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(field, 'expected an array of strings');
  }
  return value as string[];
}

/** Optional array of strings; defaults to []. */
function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  return requireStringArray(value, field);
}

function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    fail(field, 'expected a boolean');
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(field, 'expected a non-negative integer');
  }
  return value;
}

function optionalPublicBaseUrl(value: unknown): string | null {
  if (value === undefined) return null;
  const raw = requireString(value, 'public_base_url').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('public_base_url', 'expected an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('public_base_url', 'expected an absolute http(s) URL');
  }
  return raw;
}

export function parseIntegratorConfig(raw: Record<string, unknown> | undefined): IntegratorConfig {
  const obj = raw === undefined ? {} : raw;
  if (!isPlainObject(obj)) {
    throw new Error('integrator: expected an object');
  }
  return {
    theme: requireString(obj['theme'], 'theme'),
    tags: requireStringArray(obj['tags'], 'tags'),
    members: requireStringArray(obj['members'], 'members'),
    reseed: obj['reseed'] === undefined ? false : requireBool(obj['reseed'], 'reseed'),
    refresh_interval_ms:
      obj['refresh_interval_ms'] === undefined
        ? null
        : requireNonNegativeInt(obj['refresh_interval_ms'], 'refresh_interval_ms'),
    announce_to: optionalStringArray(obj['announce_to'], 'announce_to'),
    trackers: optionalStringArray(obj['trackers'], 'trackers'),
    dht: obj['dht'] === undefined ? true : requireBool(obj['dht'], 'dht'),
    announce_timeout_ms:
      obj['announce_timeout_ms'] === undefined
        ? DEFAULT_ANNOUNCE_TIMEOUT_MS
        : requireNonNegativeInt(obj['announce_timeout_ms'], 'announce_timeout_ms'),
    announce_retries:
      obj['announce_retries'] === undefined
        ? DEFAULT_ANNOUNCE_RETRIES
        : requireNonNegativeInt(obj['announce_retries'], 'announce_retries'),
    public_base_url: optionalPublicBaseUrl(obj['public_base_url']),
  };
}
