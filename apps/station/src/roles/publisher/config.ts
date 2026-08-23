/**
 * @agent-trade/station — publisher config parsing (module S3).
 *
 * Validates the `publisher` role block with field names in every error, in the
 * same style as the S1 base config loader.
 */

import type { PublisherConfig } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 5000;
const DEFAULT_ANNOUNCE_RETRIES = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new Error(`publisher.${field}: ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(field, 'expected a non-empty string');
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(field, 'expected an array of strings');
  }
  return value as string[];
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

export function parsePublisherConfig(raw: Record<string, unknown> | undefined): PublisherConfig {
  const obj = raw === undefined ? {} : raw;
  if (!isPlainObject(obj)) {
    throw new Error('publisher: expected an object');
  }
  return {
    catalog_dir: requireString(obj['catalog_dir'], 'catalog_dir'),
    trackers: requireStringArray(obj['trackers'], 'trackers'),
    announce_to: requireStringArray(obj['announce_to'], 'announce_to'),
    watch: obj['watch'] === undefined ? false : requireBool(obj['watch'], 'watch'),
    dht: obj['dht'] === undefined ? true : requireBool(obj['dht'], 'dht'),
    poll_interval_ms:
      obj['poll_interval_ms'] === undefined
        ? DEFAULT_POLL_INTERVAL_MS
        : requireNonNegativeInt(obj['poll_interval_ms'], 'poll_interval_ms'),
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
