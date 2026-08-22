/**
 * Seed a directory over BitTorrent via WebTorrent (Node build: DHT/LSD/PEX
 * built in). Returns the info hash, magnet URI, `.torrent` file bytes and a
 * `stop()` that stops seeding and releases the client.
 *
 * `opts.tracker` announces to the given tracker URLs (baked into the torrent
 * file and the magnet URI). `opts.dht` defaults to `true`; set it to `false`
 * for deterministic, tracker-only tests.
 */

import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

export interface SeedOptions {
  /** announce tracker URLs, e.g. `['http://127.0.0.1:8080/announce']` */
  tracker?: string[];
  /** enable DHT peer discovery (default true; false for tracker-only tests) */
  dht?: boolean;
}

export interface SeedResult {
  infoHash: string;
  magnetURI: string;
  /** the `.torrent` file bytes */
  torrentFile: Uint8Array;
  /** stop seeding and destroy the client */
  stop(): Promise<void>;
}

/** Destroy a webtorrent client, ignoring errors (safe to call once). */
function destroyClient(client: WebTorrent): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      client.destroy(() => resolve());
    } catch {
      resolve(); // already destroyed
    }
  });
}

export function seed(dir: string, opts?: SeedOptions): Promise<SeedResult> {
  return new Promise<SeedResult>((resolve, reject) => {
    const client = new WebTorrent({
      dht: opts?.dht ?? true,
      lsd: false,
      tracker: true,
    });
    const fail = (err: unknown): void => {
      void destroyClient(client).finally(() => reject(err instanceof Error ? err : new Error(String(err))));
    };
    client.on('error', fail);

    let torrent: Torrent;
    try {
      torrent = client.seed(dir, { announce: opts?.tracker ?? [] });
    } catch (err) {
      fail(err);
      return;
    }
    torrent.on('error', fail);

    torrent.on('ready', () => {
      resolve({
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        torrentFile: new Uint8Array(torrent.torrentFile),
        stop: () => destroyClient(client),
      });
    });
  });
}
