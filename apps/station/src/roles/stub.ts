/**
 * @agent-trade/station — S1 stub roles (module S1).
 *
 * Each stub starts an HTTP server that answers `GET /healthz`, proving the base
 * can dispatch any role. S2–S4 replace each stub by registering the real role
 * in the role registry; the `/healthz` shape is fixed by CONTRACT.md.
 */

import { createServer } from 'node:http';

import type { StationContext, StationRole, StationRoleName } from '../types.js';

export interface StubHandle {
  stop(): Promise<void>;
  port: number;
}

export function createStubRole(role: StationRoleName): StationRole {
  return {
    name: role,
    async start(ctx: StationContext): Promise<StubHandle> {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/healthz') {
          const body = JSON.stringify({ ok: true, role, agentId: ctx.agentId });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(ctx.config.http.port, ctx.config.http.host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      server.on('error', (err) => {
        ctx.logger('error', 'stub http server error', { error: String(err) });
      });

      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : ctx.config.http.port;

      ctx.logger('info', 'stub role listening', { role, host: ctx.config.http.host, port, agentId: ctx.agentId });

      return {
        port,
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    },
  };
}
