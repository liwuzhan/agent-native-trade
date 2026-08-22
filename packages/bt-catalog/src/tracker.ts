/**
 * Deterministic local BitTorrent tracker (tests only).
 *
 * Thin wrapper over `bittorrent-tracker`'s HTTP server so tests can run
 * tracker-mediated seed/download round-trips without touching the public DHT.
 * The default port `0` asks the OS for a free port, which the caller can read
 * from the resolved `port`.
 */

import type { AddressInfo } from 'node:net';
import TrackerServer from 'bittorrent-tracker/server';

export interface TrackerHandle {
  port: number;
  close(): Promise<void>;
}

export function startTracker(port = 0): Promise<TrackerHandle> {
  return new Promise<TrackerHandle>((resolve, reject) => {
    const server = new TrackerServer({
      http: true,
      udp: false,
      ws: false,
      stats: false,
      // Short announce interval (5s) so tracker-only tests self-heal even if a
      // client's first announce misses the seeder; a 10-minute default would
      // hang the round-trip on that race.
      interval: 5_000,
    });
    server.once('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.http?.address();
      if (!address || typeof address === 'string') {
        reject(new Error('tracker HTTP server has no bound address'));
        return;
      }
      const bound = (address as AddressInfo).port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((res, rej) => {
            try {
              server.close((err) => (err ? rej(err) : res()));
            } catch (err) {
              rej(err instanceof Error ? err : new Error(String(err)));
            }
          }),
      });
    });
  });
}
