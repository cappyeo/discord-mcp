import { bench, describe } from 'vitest';
import { createDebouncer } from './debounce.js';

/**
 * Plan 12 Phase E.1 — performance bench for the gateway debouncer.
 *
 * Each scenario builds a fresh debouncer, fires N events synchronously,
 * then awaits a single tick past the window so the timer drains. We
 * measure wall-clock for the whole burst (event-fan + drain). The
 * "no events" baseline measures debouncer-creation overhead alone.
 *
 * Run via `pnpm --filter @discord-mcp/core bench`. CI does NOT gate on
 * bench p50/p95.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('debounce bench', () => {
  bench(
    'debounce no events',
    async () => {
      let fired = 0;
      const debounced = createDebouncer<[number]>(() => {
        fired++;
      }, 100);
      // No firings — confirm no work happens (and no timer leaks).
      void debounced;
      void fired;
    },
    { iterations: 100 },
  );

  bench(
    'debounce 10 events / 300ms window',
    async () => {
      let fired = 0;
      const debounced = createDebouncer<[number]>(() => {
        fired++;
      }, 300);
      for (let i = 0; i < 10; i++) {
        debounced(i);
      }
      // Wait past the window so the trailing fire executes.
      await sleep(310);
      void fired;
    },
    { iterations: 100 },
  );

  bench(
    'debounce 100 events / 1s window',
    async () => {
      let fired = 0;
      const debounced = createDebouncer<[number]>(() => {
        fired++;
      }, 1000);
      // Fire 100 events back-to-back inside ~10ms.
      for (let i = 0; i < 100; i++) {
        debounced(i);
        if (i % 10 === 9) await sleep(1);
      }
      // Wait past the window for the trailing fire.
      await sleep(1010);
      void fired;
    },
    { iterations: 100 },
  );
});
