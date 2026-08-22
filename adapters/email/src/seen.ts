import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persisted store of processed Message-IDs. Powers poll() idempotency:
 * a Message-ID that was already handled is never delivered twice, even
 * across adapter restarts or duplicate deliveries on the IMAP side.
 */
export class SeenStore {
  readonly #path: string;
  #ids: Set<string>;
  #dirty = false;

  private constructor(path: string, ids: Iterable<string>) {
    this.#path = path;
    this.#ids = new Set(ids);
  }

  /** Load an existing store from disk; a missing file yields an empty store. */
  static async open(path: string): Promise<SeenStore> {
    let ids: string[] = [];
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`seen store ${path} is not a JSON array`);
      }
      ids = parsed.filter((x): x is string => typeof x === 'string');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new SeenStore(path, ids);
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  add(id: string): void {
    if (!this.#ids.has(id)) {
      this.#ids.add(id);
      this.#dirty = true;
    }
  }

  get size(): number {
    return this.#ids.size;
  }

  /** Persist to disk (atomic tmp-file + rename). No-op when nothing changed. */
  async save(): Promise<void> {
    if (!this.#dirty) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.#ids], null, 2));
    await rename(tmp, this.#path);
    this.#dirty = false;
  }
}
