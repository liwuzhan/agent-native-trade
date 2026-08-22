#!/usr/bin/env node
/**
 * @agent-trade/station CLI (module S1).
 *
 *   station <indexer|publisher|integrator> --config <path>
 *
 * S1 ships stub roles; S2–S4 register the real implementations.
 */

import { runStation } from './run.js';
import { createIndexerRole } from './roles/indexer/index.js';
import { createPublisherRole } from './roles/publisher/index.js';

async function main(): Promise<number> {
  try {
    // S2 registers the indexer role; S3 registers the publisher role. The
    // integrator (S4) still falls back to the S1 stub.
    await runStation({ indexer: createIndexerRole(), publisher: createPublisherRole() }, process.argv.slice(2));
    return 0;
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }
}

const code = await main();
process.exitCode = code;
