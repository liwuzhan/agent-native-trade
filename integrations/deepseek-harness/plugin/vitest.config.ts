import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // daemon spawn 冒烟测试起子进程，串行避免资源竞争
    fileParallelism: false,
  },
});
