import { describe, expect, it } from 'vitest';

import { objectId, verifyFile } from '../src/index.js';
import { loadVectors, resolveKeyFor } from './helpers.js';

const vectors = loadVectors();
const resolveKey = resolveKeyFor(vectors.identities);

describe('M2 acceptance 1: all 6 vector cases pass the full verifyFile (incl. schema step)', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(verifyFile(c.file, resolveKey)).toBe(c.expect);
    });
  }
});

describe('object_id derivation matches the vectors (specification.md §2)', () => {
  for (const c of vectors.cases) {
    if (!c.object_id) continue; // tampered cases carry no declared object_id
    it(`${c.name} → ${c.object_id.slice(0, 12)}…`, () => {
      expect(objectId(c.file)).toBe(c.object_id);
    });
  }
});
