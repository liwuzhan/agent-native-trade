import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // The stdio spawn test starts a child process per connect; keep it serial
    // so parallel workers never fight over tmpdir/proc resources.
    fileParallelism: false,
  },
});
