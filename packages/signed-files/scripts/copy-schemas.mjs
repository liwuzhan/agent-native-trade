#!/usr/bin/env node
// Build-time schema copy (module card M2, 边界: "protocol/schemas/*.json 在构建期
// 复制进包内（src/schemas/），运行时读包内副本，不依赖仓库相对路径").
//
// Copies protocol/schemas/*.json into BOTH:
//   - src/schemas/   — dev/test copy (vitest resolves import.meta.url to src/)
//   - dist/schemas/  — built copy (runtime reads it next to dist/index.js)
//
// Runtime code only ever loads schemas via `new URL('./schemas/…', import.meta.url)`,
// i.e. the in-package copy; it never opens the protocol/ directory.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const source = join(pkg, '..', '..', 'protocol', 'schemas');
const targets = [join(pkg, 'src', 'schemas'), join(pkg, 'dist', 'schemas')];

const files = readdirSync(source).filter((f) => f.endsWith('.json'));
if (files.length === 0) throw new Error(`no schemas found in ${source}`);
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) cpSync(join(source, f), join(dir, f));
}
console.log(`copied ${files.join(', ')} -> src/schemas, dist/schemas`);
