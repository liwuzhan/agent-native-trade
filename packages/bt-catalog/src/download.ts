/**
 * Download a catalog from a magnet URI via WebTorrent into `destDir`, then
 * build the canonical {@link Manifest} from the downloaded files. Resolves once
 * every piece is on disk and the client has been torn down.
 *
 * `opts.tracker` adds announce tracker URLs (in addition to any `tr=` params
 * already present in the magnet URI). `opts.dht` defaults to `true`; set it to
 * `false` for deterministic, tracker-only tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

import { buildManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

export interface DownloadOptions {
  /** additional announce tracker URLs */
  tracker?: string[];
  /** enable DHT peer discovery (default true; false for tracker-only tests) */
  dht?: boolean;
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

export function download(magnetURI: string, destDir: string, opts?: DownloadOptions): Promise<Manifest> {
  return new Promise<Manifest>((resolve, reject) => {
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
      torrent = client.add(magnetURI, { path: destDir, announce: opts?.tracker ?? [] });
    } catch (err) {
      fail(err);
      return;
    }
    torrent.on('error', fail);

    torrent.on('done', () => {
      (async () => {
        const files: { path: string; data: Uint8Array }[] = [];
        for (const file of torrent.files) {
          const buf = await fs.promises.readFile(path.join(destDir, file.path));
          files.push({ path: file.path, data: new Uint8Array(buf) });
        }
        const manifest = buildManifest(files);
        await destroyClient(client);
        resolve(manifest);
      })().catch(fail);
    });
  });
}
