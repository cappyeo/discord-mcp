/**
 * Unit tests for `otelReachableCheck` - Plan 9 Phase C.
 *
 * Like token-online.test.ts we mock `fetch` via `vi.stubGlobal`. The
 * privacy invariant - OTEL_EXPORTER_OTLP_HEADERS never appears in
 * `details` or `message` - is exercised by a dedicated test that uses
 * a recognizable token-shaped header value.
 */
import type { Config } from '@discord-mcp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { otelReachableCheck } from './otel-reachable.js';

function makeConfig(overrides: Partial<Config>): Config {
  // Defaults that keep the OTel branch deterministic. Tests override
  // OTEL_ENABLED / endpoint / headers as needed.
  return {
    OTEL_ENABLED: false,
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_HEADERS: undefined,
    ...overrides,
  } as unknown as Config;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('otelReachableCheck', () => {
  it('has the correct id, description, and online flag', () => {
    expect(otelReachableCheck.id).toBe('otel-reachable');
    expect(otelReachableCheck.description).toBe('OTLP endpoint reachability');
    expect(otelReachableCheck.online).toBe(true);
  });

  it('returns warn without making a request when config is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(null);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('config invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok WITHOUT making a network call when OTEL_ENABLED=false', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(makeConfig({ OTEL_ENABLED: false }));
    expect(r.status).toBe('ok');
    expect(r.message).toContain('OTEL_ENABLED=false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns warn when OTEL_ENABLED=true but no endpoint is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({ OTEL_ENABLED: true, OTEL_EXPORTER_OTLP_ENDPOINT: undefined }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('no OTLP endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('ok');
    expect(r.details?.status).toBe(200);
    expect(r.details?.method).toBe('HEAD');
  });

  it('returns ok on 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('ok');
    expect(r.details?.status).toBe(204);
  });

  it('returns ok on 405 (method not allowed but server alive)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 405 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('ok');
    expect(r.details?.status).toBe(405);
  });

  it('returns warn on non-405 4xx (e.g. 401)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('rejected');
    expect(r.details?.status).toBe(401);
  });

  it('returns warn on 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('503');
    expect(r.details?.status).toBe(503);
  });

  it('returns fail on connection refused', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:4318'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.message).toContain('unreachable');
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('returns fail on timeout (AbortError) via fake timers', async () => {
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    const promise = otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    await vi.advanceTimersByTimeAsync(3001);
    const r = await promise;
    vi.useRealTimers();

    expect(r.status).toBe('fail');
    expect(r.message).toContain('unreachable');
  });

  it('NEVER includes OTEL_EXPORTER_OTLP_HEADERS value in details/message', async () => {
    const SECRET_HEADER = 'authorization=Bearer super-secret-token-xyz';
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: SECRET_HEADER,
      }),
    );
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain('super-secret-token-xyz');
    // We DO surface the count.
    expect(r.details?.headers_configured).toBe(1);
  });

  it('NEVER includes inline basic-auth credentials from the endpoint in details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:s3cret-api-key@otlp.example.com:4318',
      }),
    );
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('s3cret-api-key');
    expect(dump).not.toContain('collector:');
    // Host and port stay visible - that's the diagnostically useful part.
    expect(r.details?.endpoint).toContain('otlp.example.com:4318');
  });

  it('still sends the credentials on the wire even though they are redacted in details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:s3cret-api-key@otlp.example.com:4318',
      }),
    );
    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toBe('https://collector:s3cret-api-key@otlp.example.com:4318/v1/traces');
  });

  it('redacts credentials on the unreachable path too', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:s3cret-api-key@otlp.example.com:4318',
      }),
    );
    expect(r.status).toBe('fail');
    expect(JSON.stringify(r)).not.toContain('s3cret-api-key');
  });

  it('leaves a credential-free endpoint byte-identical in details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    expect(r.details?.endpoint).toBe('http://localhost:4318');
  });

  it('counts comma-separated headers correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'a=1,b=2,c=3',
      }),
    );
    expect(r.details?.headers_configured).toBe(3);
  });

  it('probes OTLP logs for an enabled otlp audit sink and sends configured headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=secret-value',
        MCP_AUDIT_ENABLED: true,
        MCP_AUDIT_SINK: 'otlp',
      }),
    );
    expect(r.status).toBe('ok');
    expect(r.details?.logs_status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'HEAD',
      headers: { 'x-api-key': 'secret-value' },
    });
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });

  it('warns when the configured OTLP audit logs endpoint rejects the probe', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        MCP_AUDIT_ENABLED: true,
        MCP_AUDIT_SINK: 'otlp',
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.details?.logs_status).toBe(401);
    expect(r.message).toContain('audit logs');
  });

  it('hits the configured endpoint at /v1/traces with HEAD method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; signal: AbortSignal },
    ];
    expect(url).toBe('http://localhost:4318/v1/traces');
    expect(init.method).toBe('HEAD');
  });

  it('strips trailing slash from endpoint to avoid double "/"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await otelReachableCheck.run(
      makeConfig({
        OTEL_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/',
      }),
    );
    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://localhost:4318/v1/traces');
  });
});
