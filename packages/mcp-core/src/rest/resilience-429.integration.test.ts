import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { server as mswServer } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { http, passthrough } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { buildPolicy } from './policy.js';
import { wrapRestWithResilience } from './resilient.js';

/**
 * Integration: assert that on a Discord 429 the retry backoff honors the
 * `retry_after` body field (NOT generic exponential backoff).
 *
 * Discord's 429 JSON body includes `retry_after` in seconds. Production REST
 * instances reject the SDK's internal wait as a `RateLimitError`; our
 * classifier gives its millisecond delay to Cockatiel, which owns the retry.
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
    MCP_RETRY_ENABLED: true,
    MCP_RETRY_MAX_ATTEMPTS: 3,
    // Set base/max delays *much smaller* than retry-after so any delay >=
    // retry-after must come from the retry-after path, not exponential.
    MCP_RETRY_BASE_DELAY_MS: 50,
    MCP_RETRY_MAX_DELAY_MS: 100,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 10000,
    MCP_CIRCUIT_ENABLED: false,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 10,
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 60000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

let httpServer: HttpServer;
let baseUrl: string;
let requestTimestamps: number[];
let scriptedResponses: Array<{ status: number; body: string; headers?: Record<string, string> }>;

function buildRest(rejectOnRateLimit: () => boolean = () => true): REST {
  return new REST({
    version: '10',
    api: baseUrl,
    retries: 0,
    rejectOnRateLimit,
    makeRequest: fetch,
  }).setToken('fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
}

beforeAll(async () => {
  scriptedResponses = [];
  requestTimestamps = [];
  httpServer = createServer((_req, res) => {
    requestTimestamps.push(Date.now());
    const next = scriptedResponses.shift() ?? { status: 500, body: '{"unscripted":true}' };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...next.headers,
    };
    res.writeHead(next.status, headers);
    res.end(next.body);
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
  scriptedResponses = [];
  requestTimestamps = [];
  mswServer.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

afterEach(() => {
  scriptedResponses = [];
});

describe('resilience 429 retry-after integration (Plan 8 C.5)', () => {
  it('hands a pre-emptive SDK bucket wait to Cockatiel before the next network call', async () => {
    scriptedResponses = [
      {
        status: 200,
        body: '{"id":"warmup"}',
        headers: {
          'x-ratelimit-limit': '1',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset-after': '1',
        },
      },
      { status: 200, body: '{"id":"after-cooldown"}' },
    ];
    const rejectOnRateLimit = vi.fn(() => true);
    const rest = wrapRestWithResilience(buildRest(rejectOnRateLimit), buildPolicy(cfg()));

    await expect(rest.get('/channels/123')).resolves.toEqual({ id: 'warmup' });
    const start = Date.now();
    await expect(rest.get('/channels/123')).resolves.toEqual({ id: 'after-cooldown' });
    const elapsed = Date.now() - start;

    expect(rejectOnRateLimit).toHaveBeenCalled();
    expect(requestTimestamps).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it('honors Discord 429 retry_after - gap between attempts >= retry_after', async () => {
    // First response: 429 with retry_after = 1.0 second.
    // Second response: 200 OK.
    scriptedResponses = [
      {
        status: 429,
        body: JSON.stringify({
          code: 0,
          message: 'You are being rate limited.',
          retry_after: 1.0,
          global: false,
        }),
        headers: { 'retry-after': '1' },
      },
      { status: 200, body: '{"id":"recovered"}' },
    ];
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    const start = Date.now();
    const result = (await rest.post('/channels/123/messages', {
      body: { content: 'hi' },
    })) as { id: string };
    const elapsed = Date.now() - start;

    expect(result).toEqual({ id: 'recovered' });
    expect(requestTimestamps.length).toBe(2);
    // Allow 100ms scheduler slack on a 1s retry-after.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // Gap between the two server-side timestamps reflects the backoff.
    const gap = (requestTimestamps[1] ?? 0) - (requestTimestamps[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(900);
  }, 10000);
});
