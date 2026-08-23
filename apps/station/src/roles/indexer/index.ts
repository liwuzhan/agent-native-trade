/**
 * @agent-trade/station — indexer role (module S2).
 *
 * Wires the S1 base (StationContext) to the M8 kernel (`@agent-trade/demo-indexer`
 * `Indexer`): weights from `config.indexer.weights_file` (read at start; restart
 * to reload), site identity from the station seed, the M8 receipt/catalog/export
 * endpoints, plus the S1 announce contract, the yellow-pages tag search and the
 * read-only status page.
 */

import { Indexer, loadWeights, weightsHash } from '@agent-trade/demo-indexer';

import type { StationContext, StationRole } from '../../types.js';
import { resolveIndexerConfig } from './config.js';
import { buildIndexerApp, startIndexerHttp } from './server.js';
import { IndexerState } from './state.js';

export interface IndexerRoleHandle {
  stop(): Promise<void>;
  port: number;
}

/** The indexer role with its concrete handle (richer than the base `StationRole`). */
export interface IndexerRole extends StationRole {
  start(ctx: StationContext): Promise<IndexerRoleHandle>;
}

export function createIndexerRole(): IndexerRole {
  return {
    name: 'indexer',
    async start(ctx: StationContext): Promise<IndexerRoleHandle> {
      const { weightsFile } = resolveIndexerConfig(ctx.config);
      const weights = loadWeights(weightsFile);
      const weightsHashValue = weightsHash(weights);

      // Use the station's own identity as the indexer site identity (the M8
      // Indexer picks up the seed from the shared key store, so the snapshot's
      // indexer_public_key and the status page's public key agree).
      ctx.store.saveKey(ctx.agentId, ctx.secretKey);

      const indexer = new Indexer({ dir: ctx.dataDir, weights, indexerId: ctx.agentId });

      const resolveKey = (signer: string): string | undefined => ctx.store.getPublicKey(signer);

      const state = new IndexerState(ctx.dataDir);
      const app = buildIndexerApp({ ctx, indexer, state, weightsHashValue, resolveKey });

      const http = await startIndexerHttp(app, ctx.config.http.host, ctx.config.http.port);
      ctx.logger('info', 'indexer role listening', {
        host: ctx.config.http.host,
        port: http.port,
        agentId: ctx.agentId,
        weights_file: weightsFile,
      });

      let stopped = false;
      return {
        port: http.port,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await http.stop();
          indexer.close();
        },
      };
    },
  };
}
