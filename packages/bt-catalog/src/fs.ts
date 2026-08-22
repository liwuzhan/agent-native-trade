/**
 * Internal filesystem helpers. Not part of the public API (not re-exported
 * from `index.ts`); used by tests and by the transport layer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Recursively read a directory into `{ path, data }` entries whose `path` is
 * the forward-slash path relative to `root` (so the result is directly usable
 * with {@link buildManifest} / {@link verifyCatalogFiles}).
 */
export async function readDirFiles(root: string): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const buf = await fs.promises.readFile(abs);
        out.push({ path: relPath, data: new Uint8Array(buf) });
      }
      // skip symlinks and special files — the catalog only covers regular files
    }
  }
  await walk(root, '');
  return out;
}

/** Create a temporary directory (wrapper around fs.mkdtemp). */
export function makeTempDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), prefix));
}

/** Recursively remove a directory. */
export async function rmDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}
