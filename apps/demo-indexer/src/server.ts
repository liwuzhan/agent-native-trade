/**
 * demo-indexer HTTP surface (module M8): hono + @hono/node-server.
 *
 *   POST /receipts          submit a TRADE_RECEIPT (signed envelope JSON)
 *   GET  /subjects/:agentId aggregated view priced with current weights
 *   GET  /export            signed static snapshot (snapshot + detached sig)
 *   PUT  /catalogs/:hash    catalog archive mirror (validated against manifest)
 *   GET  /catalogs/:hash    byte-identical archived catalog
 *   GET  /health            liveness
 */

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';

import { IndexerError } from './types.js';
import type { Indexer } from './indexer.js';

const RECEIPT_MAX_BYTES = 512 * 1024;
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;

export function createIndexerApp(indexer: Indexer): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

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
      const result = await indexer.submitReceipt(file as Parameters<Indexer['submitReceipt']>[0]);
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
    try {
      indexer.storeCatalog(c.req.param('hash'), raw);
      return c.json({ status: 'stored', catalog_hash: c.req.param('hash') }, 201);
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

export interface StartedServer {
  server: ServerType;
  port: number;
  close(): Promise<void>;
}

/** Start the hono app on 127.0.0.1; port 0 picks a free port (tests). */
export async function startIndexerServer(indexer: Indexer, port = 0, hostname = '127.0.0.1'): Promise<StartedServer> {
  const app = createIndexerApp(indexer);
  const server = serve({ fetch: app.fetch, hostname, port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
