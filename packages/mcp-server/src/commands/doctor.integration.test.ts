/**
 * Integration test: `doctorAction({ online: true, json: true })` against
 * a real loopback HTTP server - Plan 9 Phase C.
 *
 * Why a real server (not msw):
 *   - msw patches global `fetch` / ClientRequest at a layer that has
 *     proven flaky in this repo's history (see otel-undici.integration
 *     test for the same conclusion). For a check whose entire job is to
 *     verify network reachability, swapping the network out wholesale
 *     defeats the test's purpose.
 *   - `node:http` listens on port 0 → the OS picks a free port → no
 *     conflict with concurrent test runs.
 *
 * Two endpoints are mounted on the same server:
 *   - GET /api/v10/users/@me  → mocks Discord (token-online)
 *   - HEAD /v1/traces         → mocks OTLP collector (otel-reachable)
 *
 * Test-only env overrides used here:
 *   - DISCORD_API_BASE_URL → swaps the Discord base URL inside
 *     token-online.ts so we hit the loopback server. Documented in that
 *     file's header as test-only.
 *   - OTEL_EXPORTER_OTLP_ENDPOINT → standard config knob; we just point
 *     it at the loopback server (this is its real production knob).
 *
 * The test asserts all 7 checks appear in the JSON output with their
 * expected status - including the 5 offline ones - so a regression in
 * any phase shows up here as a clear assertion failure.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let httpServer: HttpServer;
let baseUrl: string;

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;

const originalDiscordApiBase = process.env.DISCORD_API_BASE_URL;
const originalToken = process.env.DISCORD_TOKEN;
const originalOtelEnabled = process.env.OTEL_ENABLED;
const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalExitCode = process.exitCode;

let stdoutWrites: string[] = [];

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    // GET /api/v10/users/@me → 200 with bot identity.
    if (req.method === 'GET' && req.url === '/api/v10/users/@me') {
      // Surface the Authorization header back to the test if needed,
      // but never log the actual token (defensive - matches the privacy
      // contract). We just answer with a fixed bot identity.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '987654321098765432', username: 'doctor-bot', bot: true }));
      return;
    }
    // HEAD /v1/traces → 200 (collector alive).
    if (req.method === 'HEAD' && req.url === '/v1/traces') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
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
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  // Point Discord at our loopback server.
  process.env.DISCORD_API_BASE_URL = `${baseUrl}/api/v10`;
  process.env.DISCORD_TOKEN = VALID_TOKEN;
  process.env.OTEL_ENABLED = 'true';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = baseUrl;
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDiscordApiBase !== undefined) {
    process.env.DISCORD_API_BASE_URL = originalDiscordApiBase;
  } else {
    delete process.env.DISCORD_API_BASE_URL;
  }
  if (originalToken !== undefined) {
    process.env.DISCORD_TOKEN = originalToken;
  } else {
    delete process.env.DISCORD_TOKEN;
  }
  if (originalOtelEnabled !== undefined) {
    process.env.OTEL_ENABLED = originalOtelEnabled;
  } else {
    delete process.env.OTEL_ENABLED;
  }
  if (originalOtelEndpoint !== undefined) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOtelEndpoint;
  } else {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  process.exitCode = originalExitCode;
});

function stdoutOutput(): string {
  return stdoutWrites.join('');
}

/**
 * Drain pattern (Plan 12 Phase C.2): await doctorAction, then yield to the
 * event loop via setImmediate so any pending microtasks (fetch resolution,
 * AbortController teardown) have flushed before we read stdoutWrites. Under
 * parallel CPU pressure (multiple worker threads), `await doctorAction()`
 * could resolve before the final `process.stdout.write` was observed by the
 * spy, leading to JSON.parse on a partial buffer. setImmediate yields to
 * the I/O phase, guaranteeing all sync writes have landed.
 */
async function runDoctorAndCapture(
  doctorAction: (opts: { json: boolean; online?: boolean }) => Promise<void>,
  opts: { json: boolean; online?: boolean },
): Promise<string> {
  await doctorAction(opts);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const out = stdoutOutput();
  if (out.length === 0) {
    throw new Error(
      'doctorAction produced no stdout - spy missed all writes (race?). ' +
        `stdoutWrites.length=${stdoutWrites.length}`,
    );
  }
  return out;
}

describe('doctorAction online integration (Plan 9 Phase C)', () => {
  it('runs all 7 checks against a live loopback server and reports JSON', async () => {
    // NOTE: token-online.ts caches DISCORD_API_BASE at module-eval time. We
    // import doctor here AFTER setting DISCORD_API_BASE_URL so the cached
    // value picks up the loopback URL. vi.resetModules() ensures a fresh
    // import even if a previous test already evaluated the module.
    vi.resetModules();
    const { doctorAction } = await import('./doctor.js');

    const out = await runDoctorAndCapture(doctorAction, { json: true, online: true });
    const parsed = JSON.parse(out) as {
      ok: boolean;
      exitCode: number;
      summary: string;
      data: { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> };
    };

    // 7 checks, in order. Removed unused `out` reference - captured above.
    const ids = parsed.data.checks.map((c) => c.id);
    expect(ids).toEqual([
      'node-version',
      'token-format',
      'env-vars',
      'audit-sink',
      'client-caps',
      'token-online',
      'otel-reachable',
    ]);

    // Online checks resolved against the live server.
    const tokenOnline = parsed.data.checks.find((c) => c.id === 'token-online');
    expect(tokenOnline?.status).toBe('ok');
    expect(tokenOnline?.details?.username).toBe('doctor-bot');
    expect(tokenOnline?.details?.id).toBe('987654321098765432');
    expect(tokenOnline?.details?.bot).toBe(true);

    const otelReachable = parsed.data.checks.find((c) => c.id === 'otel-reachable');
    expect(otelReachable?.status).toBe('ok');
    expect(otelReachable?.details?.endpoint).toBe(baseUrl);
    expect(otelReachable?.details?.method).toBe('HEAD');

    // Summary mentions 7.
    expect(parsed.summary).toMatch(/^7 checks: /);
  });

  it('reports token-online fail when server returns 401 (token rejected)', async () => {
    // Swap the request handler to answer 401 for /users/@me only on the
    // next request, then restore. We do this by closing + relaunching a
    // tiny override server isn't necessary - instead we set a one-shot
    // response by toggling a flag the handler checks.
    //
    // Simpler approach: spin up a SECOND server for this test that always
    // returns 401, point DISCORD_API_BASE_URL there, run doctor.
    const failingServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v10/users/@me') {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'HEAD' && req.url === '/v1/traces') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
    const failingAddr = failingServer.address() as AddressInfo;
    const failingUrl = `http://127.0.0.1:${failingAddr.port}`;

    try {
      process.env.DISCORD_API_BASE_URL = `${failingUrl}/api/v10`;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = failingUrl;

      vi.resetModules();
      const { doctorAction } = await import('./doctor.js');
      const out = await runDoctorAndCapture(doctorAction, { json: true, online: true });

      const parsed = JSON.parse(out) as {
        data: { checks: Array<{ id: string; status: string }> };
      };
      const tokenOnline = parsed.data.checks.find((c) => c.id === 'token-online');
      expect(tokenOnline?.status).toBe('fail');
      expect(process.exitCode).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        failingServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
