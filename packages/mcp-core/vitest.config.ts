import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['../mcp-server-mocks/src/setup.ts'],
    // Registry-wide suites (tools/registry.invariants, audit/redact) walk the
    // tools tree and dynamically import all 192 modules. That takes ~4s alone
    // and exceeds the 5000ms default once 250 other files are competing for
    // worker threads — the same load sensitivity that made the CLI doctor
    // suite flaky. 20s still trips on a genuine hang.
    testTimeout: 20_000,
    // registry.invariants does its walk in beforeAll, which is governed by
    // hookTimeout (default 10s) rather than testTimeout.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.bench.ts',
        // Declaration-merge / type-only modules: no runtime code to cover.
        'src/container.ts',
        'src/capabilities/types.ts',
        'src/audit/schema.ts',
      ],
      // Thresholds are set at the measured level, not an aspirational one, so
      // the gate fails on a real regression instead of being permanently red
      // or permanently vacuous. Ratchet up when a batch of work raises them.
      thresholds: {
        statements: 98,
        lines: 98,
        functions: 97,
        branches: 73,
      },
    },
    // Plan 12 Phase E.1 — benchmarks run only via `vitest bench`. The explicit
    // `include` above scopes `vitest run` (test mode) to *.test.ts so .bench.ts
    // never executes as a test. In bench mode vitest swaps in its own include
    // (defaults to *.{bench,benchmark}.?(c|m)[jt]s?(x)), so we set
    // `benchmark.include` explicitly to be unambiguous.
    benchmark: {
      include: ['src/**/*.bench.ts'],
      reporters: ['default'],
    },
  },
});
