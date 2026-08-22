import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

import type { ObjectType } from './types.js';

/**
 * JSON Schema (draft 2020-12) validators for the four object envelopes.
 * Schemas are the in-package copies under src/schemas/ (dev/test) and
 * dist/schemas/ (built), placed there by scripts/copy-schemas.mjs at build
 * time — runtime never reads the repo's protocol/ directory.
 */
const SCHEMA_FILES: Record<ObjectType, string> = {
  LISTING_REF: 'listing-ref.schema.json',
  DEAL: 'deal.schema.json',
  TRADE_EVENT: 'trade-event.schema.json',
  TRADE_RECEIPT: 'trade-receipt.schema.json',
};

const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);

const validators = new Map<ObjectType, ValidateFunction>();

function getValidator(objectType: string): ValidateFunction | undefined {
  if (!(objectType in SCHEMA_FILES)) return undefined;
  const type = objectType as ObjectType;
  let validate = validators.get(type);
  if (!validate) {
    const url = new URL(`./schemas/${SCHEMA_FILES[type]}`, import.meta.url);
    const schema = JSON.parse(readFileSync(url, 'utf8')) as unknown;
    validate = ajv.compile(schema);
    validators.set(type, validate);
  }
  return validate;
}

/**
 * Step ③ of verifyFile: the envelope (and body) must pass the JSON Schema of
 * the corresponding object_type. Exported for tests so a naive verifier can be
 * built that skips only step ①.
 */
export function validateStructure(file: { object_type: ObjectType }): boolean {
  const validate = getValidator(file.object_type);
  return validate !== undefined && validate(file);
}
