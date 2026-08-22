/**
 * Schema drift guard: the body schemas shipped under src/schemas/ must stay
 * byte-identical to what scripts/extract-body-schemas.mjs derives from the
 * authoritative protocol/schemas/*.schema.json. If the protocol schema ever
 * changes, this test fails until the extracted copies are regenerated
 * (`node scripts/extract-body-schemas.mjs`).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..');
const PROTOCOL_SCHEMAS = join(APP_DIR, '..', '..', 'protocol', 'schemas');

const PAIRS = [
  { type: 'DEAL', source: 'deal.schema.json', extracted: 'deal-body.schema.json' },
  { type: 'TRADE_EVENT', source: 'trade-event.schema.json', extracted: 'trade-event-body.schema.json' },
  { type: 'TRADE_RECEIPT', source: 'trade-receipt.schema.json', extracted: 'trade-receipt-body.schema.json' },
];

function extractBody(source: Record<string, unknown>): Record<string, unknown> {
  const properties = source.properties as Record<string, unknown> | undefined;
  const body = properties?.body;
  if (typeof body !== 'object' || body === null) {
    throw new Error(`schema has no "properties.body" definition`);
  }
  return {
    $schema: source.$schema,
    $id: source.$id,
    title: source.title,
    $defs: source.$defs,
    ...(body as Record<string, unknown>),
  };
}

describe('body schemas stay in sync with protocol/schemas', () => {
  for (const { type, source, extracted } of PAIRS) {
    it(`${type} body schema matches the protocol schema's body definition`, () => {
      const full = JSON.parse(readFileSync(join(PROTOCOL_SCHEMAS, source), 'utf8')) as Record<string, unknown>;
      const expected = extractBody(full);
      expected.$id = `https://agent-trade.dev/schemas/${extracted}`;
      expected.title = `${full.title} body (extracted from protocol/schemas/${source})`;
      const actual = JSON.parse(readFileSync(join(APP_DIR, 'src', 'schemas', extracted), 'utf8')) as Record<string, unknown>;
      expect(actual).toEqual(expected);
    });
  }
});
