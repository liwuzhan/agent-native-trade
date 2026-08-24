import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agent-trade\/mcp-server\/(.+)$/, replacement: `${source('../../../apps/mcp-server/src')}/$1.ts` },
      { find: '@agent-trade/bt-catalog', replacement: source('../../../packages/bt-catalog/src/index.ts') },
      { find: '@agent-trade/contact-agentmail', replacement: source('../../../adapters/contact-agentmail/src/index.ts') },
      { find: '@agent-trade/contact-core', replacement: source('../../../packages/contact-core/src/index.ts') },
      { find: '@agent-trade/email', replacement: source('../../../adapters/email/src/index.ts') },
      { find: '@agent-trade/human-task', replacement: source('../../../adapters/human-task/src/index.ts') },
      { find: '@agent-trade/identity', replacement: source('../../../packages/identity/src/index.ts') },
      { find: '@agent-trade/local-store', replacement: source('../../../packages/local-store/src/index.ts') },
      { find: '@agent-trade/mcp-server', replacement: source('../../../apps/mcp-server/src/index.ts') },
      { find: '@agent-trade/settlement', replacement: source('../../../adapters/settlement/src/index.ts') },
      { find: '@agent-trade/signed-files', replacement: source('../../../packages/signed-files/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // daemon spawn 冒烟测试起子进程，串行避免资源竞争
    fileParallelism: false,
  },
});
