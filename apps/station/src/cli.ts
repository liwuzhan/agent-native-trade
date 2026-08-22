#!/usr/bin/env node
/**
 * @agent-trade/station CLI (module S1).
 *
 *   station <indexer|publisher|integrator> --config <path>
 *
 * S1 ships stub roles; S2–S4 register the real implementations.
 */

import { runStation } from './run.js';

async function main(): Promise<number> {
  try {
    await runStation({}, process.argv.slice(2));
    return 0;
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    return 1;
  }
}

const code = await main();
process.exitCode = code;
