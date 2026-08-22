/**
 * Body-schema validation for draft objects (specification.md §3 ③).
 *
 * The full envelope schemas require signatures.length >= 1, so an unsigned
 * draft can never pass them. The signing red line (module card M9) demands the
 * body be schema-validated BEFORE hashing/signing, so this module validates
 * just the `body` definition of each object type against the extracted body
 * schemas (src/schemas/ during dev/tests, dist/schemas/ at runtime — see
 * scripts/extract-body-schemas.mjs).
 *
 * The validator is the SDK's own JSON-Schema engine: `fromJsonSchema` from
 * `@modelcontextprotocol/server` wraps the package's bundled AJV (draft
 * 2020-12 + ajv-formats), so no extra dependency is introduced and tool-input
 * validation and protocol-body validation share one engine.
 */

import { readFileSync } from 'node:fs';

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { StandardSchemaV1 } from '@modelcontextprotocol/server';
import type { ObjectType } from '@agent-trade/signed-files';

const SCHEMA_FILES: Record<ObjectType, string> = {
  LISTING_REF: 'listing-ref-body.schema.json', // never signed by this server; placeholder
  DEAL: 'deal-body.schema.json',
  TRADE_EVENT: 'trade-event-body.schema.json',
  TRADE_RECEIPT: 'trade-receipt-body.schema.json',
};

const validators = new Map<ObjectType, StandardSchemaV1>();

function getValidator(objectType: ObjectType): StandardSchemaV1 | undefined {
  let validator = validators.get(objectType);
  if (!validator) {
    const url = new URL(`./schemas/${SCHEMA_FILES[objectType]}`, import.meta.url);
    const schema = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
    validator = fromJsonSchema(schema);
    validators.set(objectType, validator);
  }
  return validator;
}

export interface BodyValidationError {
  /** comma-joined issue messages, each prefixed with its JSON pointer path */
  message: string;
}

/**
 * Validate `body` against the schema of `objectType`. Returns the validated
 * body on success; throws {@link Error} with a precise message on failure.
 * Used before hashing/signing so an invalid draft is rejected early.
 */
export async function validateBody(objectType: ObjectType, body: unknown): Promise<unknown> {
  const validator = getValidator(objectType);
  if (!validator) {
    throw new Error(`no body schema for object type ${objectType}`);
  }
  const result = await validator['~standard'].validate(body);
  if (result.issues !== undefined) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.length ? ` at ${issue.path.join('.')}` : '';
        return `${issue.message}${path}`;
      })
      .join('; ');
    throw new Error(`body schema invalid for ${objectType}: ${issues}`);
  }
  return result.value;
}
