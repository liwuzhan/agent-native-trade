/**
 * @agent-trade/station — publisher role entry point (module S3).
 */

import type { StationContext, StationRole } from '../../types.js';
import { Publisher } from './publisher.js';
import type { PublisherHandle } from './types.js';

/** The publisher role with its concrete handle (richer than the base `StationRole`). */
export interface PublisherRole extends StationRole {
  start(ctx: StationContext): Promise<PublisherHandle>;
}

export function createPublisherRole(): PublisherRole {
  return {
    name: 'publisher',
    async start(ctx): Promise<PublisherHandle> {
      const publisher = new Publisher(ctx);
      return publisher.start();
    },
  };
}

export type {
  AnnounceResult,
  CatalogArchive,
  CatalogMetadata,
  PublishResult,
  PublisherConfig,
  PublisherHandle,
} from './types.js';
