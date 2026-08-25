/** Shared indexer discovery and bounded HTTP helpers for the client bridges. */

export const DEFAULT_INDEXER_URL = 'https://deepcrop.site';

const MAX_INDEXERS = 8;
const HTTP_TIMEOUT_MS = 7_000;

export interface IndexerHttpResult {
  ok: boolean;
  status: number;
  value: unknown;
}

function normalizeIndexerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('indexer URL must not be empty');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid indexer URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`indexer URL must use http(s): ${trimmed}`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`indexer URL must be a plain base URL: ${trimmed}`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeIndexerUrls(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeIndexerUrl(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length > MAX_INDEXERS) throw new Error(`at most ${MAX_INDEXERS} indexers may be configured`);
  }
  return out;
}

/** Undefined means the community default; an explicitly empty string disables remote discovery. */
export function parseIndexerUrls(raw: string | undefined): string[] {
  if (raw === undefined) return [DEFAULT_INDEXER_URL];
  if (raw.trim() === '') return [];
  return normalizeIndexerUrls(raw.split(','));
}

export function indexerUrlsFromArgs(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('indexer_urls must be an array of http(s) base URLs');
  }
  return normalizeIndexerUrls(value as string[]);
}

function endpointUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), `${base}/`).toString();
}

export async function indexerJson(
  base: string,
  path: string,
  init: RequestInit = {},
  maxBytes = 512 * 1024,
): Promise<IndexerHttpResult> {
  const response = await fetch(endpointUrl(base, path), {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`indexer response too large (${declared} bytes > ${maxBytes})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`indexer response too large (${bytes.byteLength} bytes > ${maxBytes})`);
  }
  let value: unknown = null;
  if (bytes.byteLength > 0) {
    try {
      value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error(`indexer returned invalid JSON (HTTP ${response.status})`);
    }
  }
  return { ok: response.ok, status: response.status, value };
}
