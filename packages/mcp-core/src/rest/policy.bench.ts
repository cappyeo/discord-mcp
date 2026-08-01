import { TaskCancelledError } from 'cockatiel';
import { bench, describe } from 'vitest';
import type { Config } from '../config.js';
import { DiscordRetryableError } from './errors.js';
import { buildPolicy } from './policy.js';

/**
 * Plan 12 Phase E.1 - performance bench for `buildPolicy` execute overhead.
 *
 * Three scenarios isolate the cost of:
 *   1. Pure policy.execute(noop) - bulkhead+timeout outermost wrapping.
 *   2. retry-once recovery (single transient → success) - exercises the
 *      retry decorator + custom backoff sampling.
 *   3. timeout fast-fail - confirms TaskCancelledError raises in <50ms
 *      with MCP_TIMEOUT_DEFAULT_MS=10.
 *
 * Run via `pnpm --filter @discord-mcp/core bench`. CI does NOT gate on
 * bench p50/p95.
 */

function cfg(partial: Partial<Config> = {}): Config {
  return {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'info',
    GATEWAY: false,
    OTEL_ENABLED: false,
    OTEL_SERVICE_NAME: 'discord-mcp',
    OTEL_SERVICE_VERSION: '0.12.0',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_HEADERS: undefined,
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
    OTEL_TRACES_SAMPLER_ARG: 1,
    OTEL_CONSOLE_EXPORTER: false,
    MCP_RETRY_ENABLED: true,
    MCP_RETRY_MAX_ATTEMPTS: 3,
    MCP_RETRY_BASE_DELAY_MS: 5,
    MCP_RETRY_MAX_DELAY_MS: 50,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 5000,
    MCP_CIRCUIT_ENABLED: false,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 10,
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 60000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

const noopPolicy = buildPolicy(cfg());
const retryPolicy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 2, MCP_RETRY_BASE_DELAY_MS: 1 }));
const timeoutPolicy = buildPolicy(cfg({ MCP_RETRY_ENABLED: false, MCP_TIMEOUT_DEFAULT_MS: 10 }));

describe('rest policy bench', () => {
  bench(
    'policy noop (success path)',
    async () => {
      await noopPolicy.execute(async () => 'ok');
    },
    { iterations: 1000 },
  );

  bench(
    'policy retry once (5xx -> 200)',
    async () => {
      let attempts = 0;
      await retryPolicy.execute(async () => {
        attempts++;
        if (attempts < 2) {
          throw new DiscordRetryableError(new Error('transient'), null);
        }
        return 'ok';
      });
    },
    { iterations: 1000 },
  );

  bench(
    'policy timeout fast-fail',
    async () => {
      try {
        await timeoutPolicy.execute(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      } catch (e) {
        if (!(e instanceof TaskCancelledError)) throw e;
      }
    },
    { iterations: 1000 },
  );
});
