import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    // The docs drift guards load the real tool registry, which means
    // dynamically importing all 204 tool modules (~4s on its own). Under
    // `turbo run test` the other packages' suites are competing for the same
    // cores. The SDK v2 suite can push a cold registry import just past 20s on
    // Windows, while the same test completes in ~4s without that contention.
    testTimeout: 40_000,
  },
});
