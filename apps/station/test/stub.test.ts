/**
 * S1 acceptance 1: minimal config starts all three stub roles, each answering
 * GET /healthz with the fixed contract shape.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

import { openStore } from '@agent-trade/local-store';

import { loadOrCreateSeed } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { createStubRole } from '../src/roles/stub.js';
import type { StationConfig, StationContext, StationRoleName } from '../src/types.js';
import { freePort, tmpDir } from './helpers.js';

const ROLES: StationRoleName[] = ['indexer', 'publisher', 'integrator'];

const opened: Array<{ dir: string; ctx: StationContext }> = [];

async function buildContext(role: StationRoleName): Promise<{ ctx: StationContext; port: number }> {
  const dir = tmpDir(`station-stub-${role}-`);
  const port = await freePort();
  const config: StationConfig = {
    agent_id: `stub-agent-${role}`,
    identity_seed_file: `${dir}/seed.key`,
    data_dir: `${dir}/data`,
    http: { host: '127.0.0.1', port },
    log: { level: 'info' },
    role,
  };
  const identity = loadOrCreateSeed(config.identity_seed_file);
  const store = openStore(config.data_dir);
  const logger = createLogger(config.log);
  const ctx: StationContext = {
    agentId: config.agent_id,
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
    config,
    dataDir: config.data_dir,
    store,
    logger,
  };
  opened.push({ dir, ctx });
  return { ctx, port };
}

afterEach(() => {
  for (const { ctx, dir } of opened.splice(0)) {
    try {
      ctx.store.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('acceptance 1: stub roles', () => {
  for (const role of ROLES) {
    it(`starts the ${role} stub and answers /healthz`, async () => {
      const { ctx, port } = await buildContext(role);
      const handle = await createStubRole(role).start(ctx);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({ ok: true, role, agentId: ctx.agentId });
      } finally {
        await handle.stop();
      }
    });
  }

  it('returns 404 for unknown paths', async () => {
    const { ctx, port } = await buildContext('indexer');
    const handle = await createStubRole('indexer').start(ctx);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await handle.stop();
    }
  });
});
