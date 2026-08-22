import { defineConfig } from 'vitest/config';

// node:sqlite (built-in) still prints an ExperimentalWarning on first import.
// It is the only zero-dependency way to sync the disposable tasks mirror into
// the local-store index.sqlite without pulling in better-sqlite3; the warning
// is noise, so suppress it for worker processes spawned after config load.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
