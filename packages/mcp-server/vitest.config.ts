/**
 * Vitest config for @discord-mcp/cli (mcp-server).
 *
 * Plan 12 Phase C.3: introduces a `globalSetup` hook that auto-builds
 * `dist/cli.js` (and transitively `@discord-mcp/core`) when missing, so
 * `cli.smoke.test.ts` no longer needs the `describe.skipIf(!cliBuilt)`
 * gate. See vitest.global-setup.ts for the setup body.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // These suites do real I/O - spawn `dist/cli.js` as a subprocess, bind
    // loopback HTTP servers, and re-evaluate the module graph via
    // vi.resetModules(). Under `turbo run test` all workspace packages run
    // concurrently, so the default 5000ms budget is exceeded by scheduling
    // pressure alone (the same files pass in isolation). 30s is generous
    // enough that only a genuine hang trips it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Shuffle so no suite can pass by source ordering alone. The seed is
    // pinned rather than left to the per-run default so a shuffle-induced
    // failure reproduces locally instead of vanishing on the next run.
    sequence: { shuffle: { tests: true, files: true }, seed: 77 },
  },
});
