/**
 * Minimal ambient types for `webtorrent@1.9` (the package ships no TS types).
 *
 * This covers only the API surface used by bt-catalog: client construction,
 * `seed`/`add`, torrent events and the magnet/torrent-file getters. It is a
 * local build-time declaration only — it is NOT emitted to `dist/` (declaration
 * emit strips implementation-only imports), so consumers of the built package
 * never see it.
 */
declare module 'webtorrent' {
  import { EventEmitter } from 'events';

  class File {
    /** Full path of the file inside the torrent, e.g. `name/sub/file.txt`. */
    path: string;
    /** File name (basename). */
    name: string;
    /** File size in bytes. */
    length: number;
    /** Read the whole file content from the store. */
    getBuffer(cb?: (err: Error | null, buffer?: Buffer) => void): Promise<Buffer> | void;
  }

  class Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    /** The `.torrent` file bytes (available after `ready`). */
    torrentFile: Buffer;
    files: File[];
    ready: boolean;
    done: boolean;
    destroyed: boolean;
    destroy(cb?: (err?: Error | null) => void): void;
    on(event: 'ready' | 'done' | 'infoHash', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  interface ClientOpts {
    dht?: boolean;
    lsd?: boolean;
    tracker?: boolean | Record<string, unknown>;
    utp?: boolean;
    torrentPort?: number;
    dhtPort?: number;
    maxConns?: number;
  }

  interface AddOpts {
    path?: string;
    announce?: string[];
    urlList?: string[];
    name?: string;
  }

  class WebTorrent extends EventEmitter {
    constructor(opts?: ClientOpts);
    dht: false | EventEmitter;
    listening: boolean;
    torrents: Torrent[];
    seed(input: string, opts?: AddOpts): Torrent;
    add(torrentId: string | Uint8Array, opts?: AddOpts): Torrent;
    destroy(cb?: (err?: Error | null) => void): void;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export default WebTorrent;
  export { File, Torrent };
}
