/**
 * @agent-trade/station — indexer role configuration (module S2).
 *
 * The base config (module S1) passes the `indexer` block through verbatim; the
 * role owns its own schema here. The only role-owned key is `weights_file`.
 */

import { resolve } from 'node:path';

import type { StationConfig } from '../../types.js';

export interface IndexerRoleConfig {
  /** Absolute path to the M8 weights JSON (read at role start; restart to reload). */
  weightsFile: string;
}

export class IndexerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexerConfigError';
  }
}

export function resolveIndexerConfig(config: StationConfig): IndexerRoleConfig {
  const block = config.indexer as { weights_file?: unknown } | undefined;
  const weightsFile = block?.weights_file;
  if (typeof weightsFile !== 'string' || weightsFile.length === 0) {
    throw new IndexerConfigError('indexer.weights_file: expected a non-empty string path');
  }
  return { weightsFile: resolve(weightsFile) };
}
