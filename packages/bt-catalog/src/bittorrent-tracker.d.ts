/**
 * Minimal ambient types for `bittorrent-tracker@11` server side (the package
 * ships no TS types). Local build-time declaration only — not emitted to dist.
 */
declare module 'bittorrent-tracker/server' {
  import { EventEmitter } from 'events';
  import type { Server as HttpServer } from 'http';

  interface ServerOpts {
    /** announce interval for clients (ms), default 10 min */
    interval?: number;
    /** trust x-forwarded-for (default false) */
    trustProxy?: boolean;
    /** start an HTTP server? or http.createServer opts (default true) */
    http?: boolean | Record<string, unknown>;
    /** start a UDP server? or dgram opts (default true) */
    udp?: boolean | Record<string, unknown>;
    /** start a websocket tracker? or WebSocketServer opts (default true) */
    ws?: boolean | Record<string, unknown>;
    /** enable web-based statistics (default true) */
    stats?: boolean;
  }

  class Server extends EventEmitter {
    constructor(opts?: ServerOpts);
    /** the underlying Node HTTP server (when http enabled) */
    http: HttpServer | null;
    listening: boolean;
    destroyed: boolean;
    listen(port?: number, hostname?: string, onlistening?: () => void): void;
    close(cb?: (err?: Error | null) => void): void;
  }

  export default Server;
}
