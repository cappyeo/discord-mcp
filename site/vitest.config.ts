import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    // The docs drift guards load the real tool registry, which means
    // dynamically importing all 192 tool modules (~4s on its own). Under
    // `turbo run test` the other packages' suites are competing for the same
    // cores, so the 5000ms default is exceeded by scheduling pressure alone.
    testTimeout: 20_000,
  },
});
