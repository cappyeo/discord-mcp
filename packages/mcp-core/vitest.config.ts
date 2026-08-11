import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['../mcp-server-mocks/src/setup.ts'],
    // Registry-wide suites (tools/registry.invariants, audit/redact) walk the
    // tools tree and dynamically import all 208 modules. That takes ~4s alone
    // and exceeds the 5000ms default once 250 other files are competing for
    // worker threads - the same load sensitivity that made the CLI doctor
    // suite flaky. 20s still trips on a genuine hang.
    testTimeout: 20_000,
    // Registry walks run in beforeAll, which is governed by hookTimeout. Give
    // them enough headroom when the full 270-file suite is saturating workers;
    // focused runs still finish in about 10s.
    hookTimeout: 60_000,
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
      // Keep the long-standing core gate separate from the new, independently
      // exercised blueprint operation graph. A global threshold would include
      // both groups and make the mature-core gate permanently red while the
      // new graph gains its own safety-path coverage. The patterns are
      // intentionally exhaustive and non-overlapping.
      thresholds: {
        'src/**/!(*blueprint*).ts': {
          statements: 98,
          lines: 98,
          functions: 97,
          branches: 73,
        },
        'src/**/*blueprint*.ts': {
          statements: 82,
          lines: 82,
          functions: 95,
          branches: 75,
        },
      },
    },
    // Plan 12 Phase E.1 - benchmarks run only via `vitest bench`. The explicit
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
