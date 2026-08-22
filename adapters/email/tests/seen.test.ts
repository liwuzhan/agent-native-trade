import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeenStore } from '../src/seen.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'seen-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('SeenStore', () => {
  it('starts empty for a missing file', async () => {
    const dir = await tempDir();
    const store = await SeenStore.open(join(dir, 'nope.json'));
    expect(store.size).toBe(0);
    expect(store.has('<m1@x>')).toBe(false);
  });

  it('persists added ids and reloads them', async () => {
    const dir = await tempDir();
    const path = join(dir, 'seen.json');

    const a = await SeenStore.open(path);
    a.add('<m1@x>');
    a.add('<m2@x>');
    a.add('<m1@x>'); // duplicate add is a no-op
    expect(a.size).toBe(2);
    await a.save();

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual(['<m1@x>', '<m2@x>']);

    const b = await SeenStore.open(path);
    expect(b.has('<m1@x>')).toBe(true);
    expect(b.has('<m2@x>')).toBe(true);
    expect(b.has('<m3@x>')).toBe(false);
  });

  it('save() is a no-op when nothing changed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'seen.json');
    const store = await SeenStore.open(path);
    await store.save(); // no ids, nothing written
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates parent directories on save', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'deep', 'seen.json');
    const store = await SeenStore.open(path);
    store.add('<m@x>');
    await store.save();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['<m@x>']);
  });

  it('throws for a corrupt store file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json');
    await expect(SeenStore.open(path)).rejects.toThrow();
  });
});
