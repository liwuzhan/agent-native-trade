/**
 * @agent-trade/station — indexer role HTTP surface (module S2).
 *
 * Thin adapter over the M8 `Indexer` kernel. The M8 hono app is intentionally
 * NOT mounted verbatim: the `PUT /catalogs/:hash` handler needs a side-effect
 * (extract + persist the catalog's tags) that the M8 handler does not have, so
 * every M8 endpoint is re-registered here as a thin passthrough to the imported
 * `Indexer` methods. The M8 kernel itself is reused unchanged.
 *
 *   GET  /healthz                    S1 contract liveness
 *   GET  /                           read-only status page (single HTML)
 *   POST /announce/listing-ref       S1 contract: verify → record reference
 *   GET  /catalogs?tag=a&tag=b       yellow pages (AND tag search)
 *   POST /receipts                   M8 intake (passthrough)
 *   GET  /subjects/:agentId          M8 subject view (passthrough)
 *   GET  /export                     M8 signed snapshot (passthrough)
 *   PUT  /catalogs/:hash             M8 mirror + tag extraction
 *   GET  /catalogs/:hash             M8 byte-identical archive (passthrough)
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { objectId, serialize, verifyFile } from '@agent-trade/signed-files';
import type { SignedFile, VerifyResult } from '@agent-trade/signed-files';
import { IndexerError } from '@agent-trade/demo-indexer';
import type { Indexer } from '@agent-trade/demo-indexer';

import type { StationContext } from '../../types.js';
import { extractCatalogTags } from './catalog-tags.js';
import { IndexerState } from './state.js';
import { reloadTrustRing } from './trust-ring.js';

const RECEIPT_MAX_BYTES = 512 * 1024;
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const LISTING_REF_MAX_BYTES = 512 * 1024;

export interface BuildIndexerAppOptions {
  ctx: StationContext;
  indexer: Indexer;
  state: IndexerState;
  weightsHashValue: string;
  resolveKey: (signer: string) => string | undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Extract the `VerifyResult` embedded in a local-store `putObject` failure
 * (`putObject: verification failed (<result>)`). Returns `undefined` for any
 * other error so non-verification failures keep their default (500) mapping.
 */
const VERIFY_FAILURE_RE = /verification failed \(([^)]+)\)/;
function verificationFailureOf(err: unknown): VerifyResult | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = VERIFY_FAILURE_RE.exec(err.message);
  return match?.[1] as VerifyResult | undefined;
}

export function buildIndexerApp(opts: BuildIndexerAppOptions): Hono {
  const { ctx, indexer, state, weightsHashValue, resolveKey } = opts;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, role: 'indexer', agentId: ctx.agentId }));

  // Read-only status page: single HTML, no JS, no interaction (module card S2).
  app.get('/', (c) => {
    const receiptCount = indexer.allSubjects().reduce((sum, view) => sum + view.receipt_count, 0);
    const catalogCount = state.catalogCount();
    const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>station indexer</title></head>
<body>
<h1>station indexer 状态</h1>
<dl>
  <dt>收录回执数</dt><dd id="receipt-count">${receiptCount}</dd>
  <dt>目录数</dt><dd id="catalog-count">${catalogCount}</dd>
  <dt>本站公钥</dt><dd id="public-key">${escapeHtml(ctx.publicKey)}</dd>
  <dt>weights_hash</dt><dd id="weights-hash">${escapeHtml(weightsHashValue)}</dd>
</dl>
</body>
</html>
`;
    return c.html(html);
  });

  // S1 announce contract (CONTRACT.md). Verification happens in §3 order via
  // verifyFile; conflicts are keyed by object_id with the full envelope as
  // "content" (object_id is a function of body_hash, so two envelopes can share
  // an object_id only when they share a body — differing signatures then differ
  // in content).
  app.post('/announce/listing-ref', async (c) => {
    const raw = await c.req.text();
    if (raw.length > LISTING_REF_MAX_BYTES) {
      return c.json({ error: 'envelope_too_large' }, 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: 'invalid_envelope' }, 400);
    }
    const file = parsed as SignedFile;
    if (file.object_type !== 'LISTING_REF') {
      return c.json({ error: 'wrong_object_type', message: `expected LISTING_REF, got ${String(file.object_type)}` }, 400);
    }

    // Hot-reload the trust ring before verification: a key added or rotated on
    // disk after openStore must be honoured without an indexer restart (the M3
    // store only snapshots `.data/keys/*.key` into memory at openStore time).
    reloadTrustRing(ctx);

    const result = verifyFile(file, resolveKey);
    if (result !== 'valid') {
      return c.json({ error: `verification failed (${result})`, verify_result: result }, 400);
    }

    const id = objectId(file);
    const content = serialize(file);
    const existing = state.findListingRef(id);
    if (existing !== undefined) {
      if (existing.content === content) {
        return c.json({ status: 'accepted', object_id: id }, 200);
      }
      return c.json({ error: 'conflict', object_id: id }, 409);
    }

    const body = file.body as {
      publisher: string;
      catalog_id: string;
      catalog_hash: string;
      item_id: string;
      item_revision?: number;
    };

    // Persist the fact (source of truth) — idempotent under the same object_id.
    // `putObject` re-verifies against the store's in-memory ring; a verification
    // failure here is still a contract-level 400 (never an HTTP 500).
    try {
      ctx.store.putObject(file);
    } catch (err) {
      const failure = verificationFailureOf(err);
      if (failure !== undefined) {
        return c.json({ error: `verification failed (${failure})`, verify_result: failure }, 400);
      }
      throw err;
    }
    state.addListingRef({
      object_id: id,
      content,
      publisher: body.publisher,
      catalog_id: body.catalog_id,
      catalog_hash: body.catalog_hash,
      item_id: body.item_id,
      item_revision: body.item_revision,
      recorded_at: new Date().toISOString(),
    });

    ctx.logger('info', 'listing-ref accepted', { object_id: id, catalog_hash: body.catalog_hash });
    return c.json({ status: 'accepted', object_id: id }, 200);
  });

  // Yellow pages: tag search over mirrored catalogs (AND semantics). Catalogs
  // without tags stay in the mirror but are absent here (module card S2 rule).
  app.get('/catalogs', (c) => {
    const queryTags = c.req.queries('tag') ?? [];
    const entries = state.taggedCatalogs().flatMap(({ catalog_hash, tags }) => {
      if (!queryTags.every((q) => tags.includes(q))) return [];
      const ref = state.listingRefs().find((r) => r.catalog_hash === catalog_hash);
      return [
        {
          catalog_hash,
          tags,
          ...(ref !== undefined
            ? {
                object_id: ref.object_id,
                publisher: ref.publisher,
                catalog_id: ref.catalog_id,
                item_id: ref.item_id,
                item_revision: ref.item_revision,
              }
            : {}),
        },
      ];
    });
    return c.json({ catalogs: entries });
  });

  // --- M8 passthrough endpoints (thin adapter over the imported Indexer) ---

  app.post('/receipts', async (c) => {
    const raw = await c.req.text();
    if (raw.length > RECEIPT_MAX_BYTES) {
      return c.json({ error: 'receipt_too_large', message: `receipt exceeds ${RECEIPT_MAX_BYTES} bytes` }, 413);
    }
    let file: unknown;
    try {
      file = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400);
    }
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      return c.json({ error: 'invalid_envelope', message: 'expected a signed envelope JSON object' }, 400);
    }
    try {
      const result = await indexer.submitReceipt(file as SignedFile);
      if (result.status === 'indexed') {
        return c.json({ status: 'indexed', object_id: result.object_id, receipt: result.record }, 201);
      }
      if (result.status === 'duplicate') {
        return c.json({ status: 'duplicate', object_id: result.object_id, receipt: result.record }, 200);
      }
      return c.json({ status: 'conflict', reason: result.reason }, 409);
    } catch (err) {
      if (err instanceof IndexerError) {
        return c.json({ error: err.reason, message: err.message }, 400);
      }
      throw err;
    }
  });

  app.get('/subjects/:agentId', (c) => {
    const view = indexer.subjectView(c.req.param('agentId'));
    if (view === undefined) {
      return c.json({ error: 'subject_not_found', agent_id: c.req.param('agentId') }, 404);
    }
    return c.json(view);
  });

  app.get('/export', (c) => {
    const bundle = indexer.exportSnapshot();
    c.header('Content-Disposition', 'attachment; filename="receipts-index.json"');
    return c.json({ snapshot: bundle.snapshot, signature: bundle.signature });
  });

  app.put('/catalogs/:hash', async (c) => {
    const raw = await c.req.text();
    if (raw.length > CATALOG_MAX_BYTES) {
      return c.json({ error: 'catalog_too_large', message: `catalog exceeds ${CATALOG_MAX_BYTES} bytes` }, 413);
    }
    const catalogHash = c.req.param('hash');
    try {
      indexer.storeCatalog(catalogHash, raw);
      // storeCatalog has verified the archive against its manifest; the tags
      // extracted from catalog.json are therefore hash-protected.
      state.setCatalogTags(catalogHash, extractCatalogTags(raw));
      return c.json({ status: 'stored', catalog_hash: catalogHash }, 201);
    } catch (err) {
      if (err instanceof IndexerError) {
        return c.json({ error: err.reason, message: err.message }, 400);
      }
      throw err;
    }
  });

  app.get('/catalogs/:hash', (c) => {
    const raw = indexer.getCatalog(c.req.param('hash'));
    if (raw === undefined) {
      return c.json({ error: 'catalog_not_found', catalog_hash: c.req.param('hash') }, 404);
    }
    return c.text(raw, 200, { 'Content-Type': 'application/json' });
  });

  return app;
}

export interface StartedIndexerHttp {
  port: number;
  stop(): Promise<void>;
}

/** Start the indexer Hono app on `hostname:port`; port 0 picks a free port. */
export async function startIndexerHttp(app: Hono, hostname: string, port: number): Promise<StartedIndexerHttp> {
  const server = serve({ fetch: app.fetch, hostname, port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  return {
    port: boundPort,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
