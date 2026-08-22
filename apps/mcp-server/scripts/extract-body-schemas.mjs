#!/usr/bin/env node
/**
 * Extract body-only JSON Schemas from the authoritative protocol schemas.
 *
 * The M9 signing red line validates a DEAL *body* before hashing/signing, but
 * the full envelope schema requires signatures.length >= 1 (an unsigned draft
 * is not yet a valid object). This script derives `<type>-body.schema.json`
 * for DEAL / TRADE_EVENT / TRADE_RECEIPT from `protocol/schemas/*.schema.json`
 * (the single source of truth, per specification.md) so the server can schema-
 * validate a draft body without depending on the repo at runtime.
 *
 * Writes both src/schemas/ (dev/test layout, committed) and dist/schemas/
 * (runtime layout, regenerated at build). A sync test compares the committed
 * src copies against the protocol schemas so drift fails CI.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/ → apps/mcp-server/ → apps/ → repo root
const ROOT = join(HERE, '..', '..', '..');
const PROTOCOL_SCHEMAS = join(ROOT, 'protocol', 'schemas');
const TARGETS = [
  { type: 'DEAL', file: 'deal.schema.json', out: 'deal-body.schema.json' },
  { type: 'TRADE_EVENT', file: 'trade-event.schema.json', out: 'trade-event-body.schema.json' },
  { type: 'TRADE_RECEIPT', file: 'trade-receipt.schema.json', out: 'trade-receipt-body.schema.json' },
];

for (const { file, out } of TARGETS) {
  const full = JSON.parse(readFileSync(join(PROTOCOL_SCHEMAS, file), 'utf8'));
  if (full.properties?.body === undefined) {
    throw new Error(`${file}: no "body" property in schema`);
  }
  const bodySchema = {
    $schema: full.$schema,
    $id: `https://agent-trade.dev/schemas/${out}`,
    title: `${full.title} body (extracted from protocol/schemas/${file})`,
    $defs: full.$defs,
    ...full.properties.body,
  };
  const text = JSON.stringify(bodySchema, null, 2) + '\n';
  for (const outDir of [join(HERE, '..', 'src', 'schemas'), join(HERE, '..', 'dist', 'schemas')]) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, out), text, 'utf8');
  }
  console.log(`extracted ${out}`);
}
