import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { server as mswServer } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { http, passthrough } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import { CircuitOpenError } from '../errors/server.js';
import { buildPolicy } from './policy.js';
import { wrapRestWithResilience } from './resilient.js';

/**
 * Integration: assert that the resilient REST adapter retries 5xx end-to-end
 * against a real HTTP server.  We avoid msw here for the reasons documented
 * in mcp-server/src/otel-undici.integration.test.ts: msw patches global
 * fetch / ClientRequest while undici dispatches at a lower layer, and the
 * conflict produces flaky behavior.  A local node:http server gives us a
 * reliable, deterministic transport.
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
    MCP_RETRY_BASE_DELAY_MS: 50,
    MCP_RETRY_MAX_DELAY_MS: 500,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 5000,
    MCP_CIRCUIT_ENABLED: false,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 10,
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 60000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

let httpServer: HttpServer;
let baseUrl: string;
let requestCount: number;
let scriptedResponses: Array<{ status: number; body: string; headers?: Record<string, string> }>;

function buildRest(): REST {
  // Point @discordjs/rest at our local server. `api` becomes the base URL.
  // `retries: 0` mimics what stdio.ts does in production (Plan 8 C.4).
  return new REST({
    version: '10',
    api: baseUrl,
    retries: 0,
    makeRequest: fetch,
  }).setToken('fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
}

beforeAll(async () => {
  scriptedResponses = [];
  requestCount = 0;
  httpServer = createServer((_req, res) => {
    requestCount++;
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
  requestCount = 0;
  // Tell msw (set up globally with onUnhandledRequest:'error') to bypass
  // requests to our local fixture server.  msw resets between tests.
  mswServer.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

afterEach(() => {
  scriptedResponses = [];
});

describe('resilience retry integration (Plan 8 C.5)', () => {
  it('retries 500 → 500 → 200 and returns the final success body', async () => {
    scriptedResponses = [
      { status: 500, body: '{"message":"upstream broken"}' },
      { status: 500, body: '{"message":"upstream still broken"}' },
      { status: 200, body: '{"id":"123","name":"ok"}' },
    ];
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    const result = (await rest.get('/channels/123')) as { id: string; name: string };
    expect(result).toEqual({ id: '123', name: 'ok' });
    // Three attempts total: 2 retries + 1 success.
    expect(requestCount).toBe(3);
  });

  it('does NOT retry on 400 — single request, original error bubbles', async () => {
    scriptedResponses = [{ status: 400, body: '{"code":50035,"message":"Invalid form body"}' }];
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    await expect(
      rest.post('/channels/123/messages', { body: { content: 'x' } }),
    ).rejects.toBeDefined();
    expect(requestCount).toBe(1);
  });

  it('exhausts retries when all attempts fail and surfaces the last error', async () => {
    scriptedResponses = Array.from({ length: 6 }, () => ({
      status: 503,
      body: '{"message":"service unavailable"}',
    }));
    const rest = wrapRestWithResilience(
      buildRest(),
      buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 2 })),
    );

    await expect(rest.get('/channels/123')).rejects.toBeDefined();
    // maxAttempts: 2 retries → 3 total tries.
    expect(requestCount).toBe(3);
  });
});

/**
 * A POST that reached Discord but whose RESPONSE was lost must NOT be
 * replayed — that duplicates the message / ban / webhook execution.  Only the
 * ambiguous classes (5xx + post-send network codes) are affected; explicit
 * rejections (429) and pre-send network failures (ECONNREFUSED) still retry.
 */
describe('resilience retry integration: POST is not replayed on ambiguous failures', () => {
  /** REST whose transport always fails with the given network `code`. */
  function buildNetworkFailingRest(code: string): REST {
    return new REST({
      version: '10',
      api: baseUrl,
      retries: 0,
      makeRequest: async () => {
        requestCount++;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket failure'), { code }),
        });
      },
    }).setToken('fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  }

  it('does NOT retry POST on 503 — single request', async () => {
    scriptedResponses = Array.from({ length: 6 }, () => ({
      status: 503,
      body: '{"message":"service unavailable"}',
    }));
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    await expect(
      rest.post('/channels/123/messages', { body: { content: 'x' } }),
    ).rejects.toBeDefined();
    expect(requestCount).toBe(1);
  });

  it('still opens the circuit on repeated POST 5xx even though it never retries', async () => {
    // The regression this guards: making ambiguous POST failures
    // "non-retryable" by classifying them as `null` also hid them from the
    // circuit breaker, which only counts DiscordRetryableError. A POST-heavy
    // workload against a fully-down Discord would then hammer it forever,
    // because nothing ever incremented the consecutive-failure counter.
    // Replay-safety and upstream-failure accounting are separate concerns.
    scriptedResponses = Array.from({ length: 10 }, () => ({
      status: 503,
      body: '{"message":"service unavailable"}',
    }));
    const rest = wrapRestWithResilience(
      buildRest(),
      buildPolicy(
        cfg({
          MCP_CIRCUIT_ENABLED: true,
          MCP_CIRCUIT_FAILURE_THRESHOLD: 3,
          MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 300_000,
        }),
      ),
    );

    for (let i = 0; i < 3; i++) {
      await expect(
        rest.post('/channels/123/messages', { body: { content: 'x' } }),
      ).rejects.toBeDefined();
    }
    // Exactly 3 requests: each POST failed once and was never replayed.
    expect(requestCount).toBe(3);

    // The 4th is short-circuited by the open breaker — no request reaches
    // Discord at all.
    await expect(
      rest.post('/channels/123/messages', { body: { content: 'x' } }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(requestCount).toBe(3);
  });

  it('does not let non-retryable 4xx trip the circuit', async () => {
    // policy.ts documents this explicitly: a validation 4xx is the caller's
    // fault, not an upstream outage, and must never contribute to shedding
    // load. Asserted here because the 5xx test above cannot distinguish
    // "the breaker counts upstream failures" from "the breaker counts
    // everything".
    scriptedResponses = Array.from({ length: 10 }, () => ({
      status: 400,
      body: '{"message":"invalid form body"}',
    }));
    const rest = wrapRestWithResilience(
      buildRest(),
      buildPolicy(
        cfg({
          MCP_CIRCUIT_ENABLED: true,
          MCP_CIRCUIT_FAILURE_THRESHOLD: 3,
          MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 300_000,
        }),
      ),
    );

    for (let i = 0; i < 5; i++) {
      await expect(
        rest.post('/channels/123/messages', { body: { content: 'x' } }),
      ).rejects.not.toBeInstanceOf(CircuitOpenError);
    }
    // All five reached Discord: the breaker never opened.
    expect(requestCount).toBe(5);
  });

  it('does NOT retry POST on ECONNRESET — single request', async () => {
    const rest = wrapRestWithResilience(buildNetworkFailingRest('ECONNRESET'), buildPolicy(cfg()));

    await expect(
      rest.post('/channels/123/messages', { body: { content: 'x' } }),
    ).rejects.toBeDefined();
    expect(requestCount).toBe(1);
  });

  it('DOES retry POST on ECONNREFUSED — the request never left the host', async () => {
    const rest = wrapRestWithResilience(
      buildNetworkFailingRest('ECONNREFUSED'),
      buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 2 })),
    );

    await expect(
      rest.post('/channels/123/messages', { body: { content: 'x' } }),
    ).rejects.toBeDefined();
    expect(requestCount).toBe(3);
  });

  it('DOES retry POST on 429 — an explicit rejection carries no duplicate risk', async () => {
    scriptedResponses = [
      {
        status: 429,
        body: JSON.stringify({
          code: 0,
          message: 'rate limited',
          retry_after: 0.05,
          global: false,
        }),
        headers: { 'retry-after': '0.05' },
      },
      { status: 200, body: '{"id":"recovered"}' },
    ];
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    const result = (await rest.post('/channels/123/messages', { body: { content: 'x' } })) as {
      id: string;
    };
    expect(result).toEqual({ id: 'recovered' });
    expect(requestCount).toBe(2);
  });

  it('still retries GET on 503 — idempotent verbs are unaffected', async () => {
    scriptedResponses = [
      { status: 503, body: '{"message":"down"}' },
      { status: 200, body: '{"id":"ok"}' },
    ];
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()));

    await expect(rest.get('/channels/123')).resolves.toEqual({ id: 'ok' });
    expect(requestCount).toBe(2);
  });
});
