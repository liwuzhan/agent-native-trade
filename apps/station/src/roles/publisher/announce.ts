/**
 * @agent-trade/station — announce to indexer stations (module S3).
 *
 * POSTs the signed LISTING_REF envelope to every `announce_to` base URL with a
 * per-attempt timeout and a finite number of retries. Failures are only logged
 * (never thrown), so an unreachable indexer cannot block seeding.
 */

import { serialize } from '@agent-trade/signed-files';
import type { SignedFile } from '@agent-trade/signed-files';

import type { AnnounceResult } from './types.js';

const LISTING_REF_PATH = '/announce/listing-ref';
const RETRY_DELAY_MS = 250;

export interface AnnounceOptions {
  timeoutMs: number;
  retries: number;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: object) => void;
}

/** Resolve an `announce_to` entry to the full announce endpoint URL. */
function targetUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith(LISTING_REF_PATH)) return trimmed;
  return `${trimmed}${LISTING_REF_PATH}`;
}

async function postOnce(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const status = res.status;
    try {
      await res.text(); // drain so keep-alive sockets are released
    } catch {
      /* ignore drain failure */
    }
    return { ok: status >= 200 && status < 300, status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function announceListingRef(
  listingRef: SignedFile,
  announceTo: string[],
  opts: AnnounceOptions,
): Promise<AnnounceResult[]> {
  const body = serialize(listingRef);
  const results: AnnounceResult[] = [];

  for (const base of announceTo) {
    const url = targetUrl(base);
    let result: AnnounceResult = { url, ok: false, attempts: 0 };

    for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
      result.attempts = attempt;
      const response = await postOnce(url, body, opts.timeoutMs);
      if (response.ok) {
        result = { url, ok: true, status: response.status, attempts: attempt };
        break;
      }
      result.status = response.status;
      result.error = response.error;
      if (attempt <= opts.retries) await delay(RETRY_DELAY_MS);
    }

    results.push(result);
    if (result.ok) {
      opts.log('info', 'announce accepted', {
        indexer: url,
        status: result.status,
        attempts: result.attempts,
      });
    } else {
      opts.log('warn', 'announce failed', {
        indexer: url,
        attempts: result.attempts,
        status: result.status,
        error: result.error,
      });
    }
  }

  return results;
}
