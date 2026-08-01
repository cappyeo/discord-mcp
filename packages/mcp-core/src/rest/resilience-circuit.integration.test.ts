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
 * Integration: circuit breaker opens after MCP_CIRCUIT_FAILURE_THRESHOLD
 * consecutive 5xx upstream responses, then short-circuits subsequent calls
 * with CIRCUIT_OPEN until halfOpenAfter elapses.
 *
 * Plan 8 D.1 + D.4 + D.6.
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
    // Disable retry so each upstream 503 increments the breaker by exactly one.
    MCP_RETRY_ENABLED: false,
    MCP_RETRY_MAX_ATTEMPTS: 3,
    MCP_RETRY_BASE_DELAY_MS: 50,
    MCP_RETRY_MAX_DELAY_MS: 500,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 5000,
    MCP_CIRCUIT_ENABLED: true,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 3,
    // Long enough that we don't half-open during a single test.
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 300_000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

let httpServer: HttpServer;
let baseUrl: string;
let requestCount: number;
let scriptedResponses: Array<{ status: number; body: string; headers?: Record<string, string> }>;

function buildRest(): REST {
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
  mswServer.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

afterEach(() => {
  scriptedResponses = [];
});

describe('resilience circuit breaker integration (Plan 8 D.6)', () => {
  it('opens after MCP_CIRCUIT_FAILURE_THRESHOLD consecutive 503s and short-circuits with CircuitOpenError', async () => {
    // Three 503s open the breaker (threshold=3). After that the wrapped REST
    // adapter should reject immediately with CircuitOpenError, NOT with a
    // bubbled-up 503.
    scriptedResponses = [
      { status: 503, body: '{"message":"down"}' },
      { status: 503, body: '{"message":"still down"}' },
      { status: 503, body: '{"message":"still down 2"}' },
    ];
    const halfOpenMs = 300_000;
    const rest = wrapRestWithResilience(buildRest(), buildPolicy(cfg()), {
      circuitHalfOpenAfterMs: halfOpenMs,
    });

    // Three 503s — each rejects with the underlying Discord error.
    for (let i = 0; i < 3; i++) {
      await expect(rest.get('/channels/123')).rejects.toBeDefined();
    }
    expect(requestCount).toBe(3);

    // Fourth call: breaker is open, so the upstream is NOT contacted.
    await expect(rest.get('/channels/123')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(requestCount).toBe(3); // unchanged — request never went out.
  });
});
