import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // WebTorrent / bittorrent-tracker are network-bound; keep tests deterministic
    // by disabling DHT in roundtrip tests (tracker-only), and give the local
    // HTTP tracker a bounded announce window.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
