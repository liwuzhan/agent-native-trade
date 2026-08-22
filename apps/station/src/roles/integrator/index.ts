/**
 * @agent-trade/station — integrator role entry point (module S4).
 */

import type { StationContext, StationRole } from '../../types.js';
import { Integrator } from './integrator.js';
import type { IntegratorHandle } from './types.js';

/** The integrator role with its concrete handle (richer than the base `StationRole`). */
export interface IntegratorRole extends StationRole {
  start(ctx: StationContext): Promise<IntegratorHandle>;
}

export function createIntegratorRole(): IntegratorRole {
  return {
    name: 'integrator',
    async start(ctx): Promise<IntegratorHandle> {
      const integrator = new Integrator(ctx);
      return integrator.start();
    },
  };
}

export type {
  CatalogArchive,
  IntegratorConfig,
  IntegratorHandle,
  MemberSummary,
  RefreshResult,
  RejectedMember,
  ReseedOutcome,
} from './types.js';
