import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./e2e/global-setup.ts'],
    // One database, shared rows: files run one after another, tests within a file in order.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
