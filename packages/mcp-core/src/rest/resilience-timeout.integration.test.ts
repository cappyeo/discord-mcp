import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { server as mswServer } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { TaskCancelledError } from 'cockatiel';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import { buildPolicy } from './policy.js';
import { wrapRestWithResilience } from './resilient.js';

/**
 * Integration: assert that when an upstream request exceeds
 * MCP_TIMEOUT_DEFAULT_MS, cockatiel's aggressive timeout aborts and the
 * surfaced error is `TaskCancelledError` (the marker existing
 * errors/format.ts maps to INTERNAL_ERROR via its else branch).
 *
 * This test uses a deliberately slow node:http server that does not respond
 * within the configured timeout.
 */

function cfg(partial: Partial<Config> = {}): Config {
  return {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'info',
    GATEWAY: false,
    OTEL_ENABLED: false,
    OTEL_SERVICE_NAME: 'discord-mcp',
    OTEL_SERVICE_VERSION: '0.8.0',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_HEADERS: undefined,
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
    OTEL_TRACES_SAMPLER_ARG: 1,
    OTEL_CONSOLE_EXPORTER: false,
    // Disable retry so we test the timeout layer in isolation.
    MCP_RETRY_ENABLED: false,
    MCP_RETRY_MAX_ATTEMPTS: 3,
    MCP_RETRY_BASE_DELAY_MS: 50,
    MCP_RETRY_MAX_DELAY_MS: 500,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 1000,
    MCP_CIRCUIT_ENABLED: false,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 10,
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 60000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

let httpServer: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  httpServer = createServer((_req, res) => {
    // Never respond within the test window; timeout policy must abort.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"too":"late"}');
    }, 5000);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  mswServer.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

describe('resilience timeout integration (Plan 8 C.5)', () => {
  it('aborts and throws a cancellation error when upstream exceeds MCP_TIMEOUT_DEFAULT_MS', async () => {
    const rest = wrapRestWithResilience(
      new REST({
        version: '10',
        api: baseUrl,
        retries: 0,
        // 30s here so @discordjs/rest itself doesn't trip the abort first.
        timeout: 30_000,
        makeRequest: fetch,
      }).setToken('fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      buildPolicy(cfg({ MCP_TIMEOUT_DEFAULT_MS: 1000 })),
    );

    const start = Date.now();
    let caught: unknown;
    try {
      await rest.get('/channels/123');
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    // Either cockatiel's TaskCancelledError, or a fetch AbortError that the
    // aggressive timeout produces by aborting the signal - both are
    // acceptable evidence the timeout fired.
    const isCancelled = caught instanceof TaskCancelledError;
    const isAbort =
      caught instanceof Error &&
      (caught.name === 'AbortError' || /aborted|cancel/i.test(caught.message));
    expect(isCancelled || isAbort).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  }, 10000);
});
