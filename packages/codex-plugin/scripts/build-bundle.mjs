import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, '..', '..');
const sourceRoot = join(repoRoot, 'integrations', 'codex', 'plugin');
const dshSourceRoot = join(repoRoot, 'integrations', 'deepseek-harness', 'plugin');
const runtimeDir = join(packageRoot, 'runtime');
const sourceRequire = createRequire(join(sourceRoot, 'package.json'));
const { build } = await import(pathToFileURL(sourceRequire.resolve('rolldown')).href);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const compress = promisify(brotliCompress);

const internalPackages = new Map([
  ['@agent-trade/bt-catalog', 'packages/bt-catalog/src'],
  ['@agent-trade/contact-agentmail', 'adapters/contact-agentmail/src'],
  ['@agent-trade/contact-core', 'packages/contact-core/src'],
  ['@agent-trade/email', 'adapters/email/src'],
  ['@agent-trade/human-task', 'adapters/human-task/src'],
  ['@agent-trade/identity', 'packages/identity/src'],
  ['@agent-trade/local-store', 'packages/local-store/src'],
  ['@agent-trade/mcp-server', 'apps/mcp-server/src'],
  ['@agent-trade/settlement', 'adapters/settlement/src'],
  ['@agent-trade/signed-files', 'packages/signed-files/src'],
]);
const internalSourceRoots = [
  ...[...internalPackages.values()].map((relativeRoot) => join(repoRoot, relativeRoot)),
  join(sourceRoot, 'src'),
  join(dshSourceRoot, 'src'),
];

const sourceResolver = {
  name: 'agent-trade-source-resolver',
  async resolveId(source, importer) {
    for (const [packageName, relativeRoot] of internalPackages) {
      if (source === packageName) return join(repoRoot, relativeRoot, 'index.ts');
      if (source.startsWith(`${packageName}/`)) {
        return join(repoRoot, relativeRoot, `${source.slice(packageName.length + 1)}.ts`);
      }
    }
    if (
      internalSourceRoots.some((root) => importer?.startsWith(root))
      && !source.startsWith('.')
      && !source.startsWith('/')
      && !builtins.has(source)
    ) {
      const resolved = await this.resolve(source, join(sourceRoot, 'src', 'mcp-server.ts'), { skipSelf: true });
      return resolved ?? null;
    }
    return null;
  },
};

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(join(runtimeDir, 'schemas'), { recursive: true });

await build({
  input: join(sourceRoot, 'src', 'mcp-server.ts'),
  platform: 'node',
  plugins: [sourceResolver],
  resolve: {
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  output: {
    file: join(runtimeDir, 'mcp-server.mjs'),
    format: 'esm',
    codeSplitting: false,
    minify: true,
    sourcemap: false,
  },
});

const runtimeFile = join(runtimeDir, 'mcp-server.mjs');
const packedRuntime = await compress(await readFile(runtimeFile), {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
});
await writeFile(`${runtimeFile}.br`, packedRuntime);
await rm(runtimeFile);

for (const name of [
  'listing-ref.schema.json',
  'deal.schema.json',
  'trade-event.schema.json',
  'trade-receipt.schema.json',
]) {
  await copyFile(join(repoRoot, 'protocol', 'schemas', name), join(runtimeDir, 'schemas', name));
}
for (const name of [
  'deal-body.schema.json',
  'trade-event-body.schema.json',
  'trade-receipt-body.schema.json',
]) {
  await copyFile(join(repoRoot, 'apps', 'mcp-server', 'src', 'schemas', name), join(runtimeDir, 'schemas', name));
}
await copyFile(join(repoRoot, 'apps', 'mcp-server', 'policy.json'), join(packageRoot, 'policy.json'));

process.stdout.write(`built ${join(runtimeDir, 'mcp-server.mjs.br')}\n`);
