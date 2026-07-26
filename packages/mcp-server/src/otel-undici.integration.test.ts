import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactRoute } from '@discord-mcp/core';
import { metrics, trace } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Phase B integration: assert that wiring UndiciInstrumentation with the
 * Phase B requestHook produces the expected span shape against a real
 * undici dispatcher.
 *
 * We avoid msw here on purpose. msw patches global `fetch` /
 * ClientRequest, while UndiciInstrumentation hooks the undici dispatch
 * pipeline at a lower layer; the two collide and the spans never fire
 * (see packages/mcp-core/src/tools/messages/send.test.ts, which
 * sidesteps the same issue with `makeRequest: fetch`). Instead we boot
 * a local Node http.Server, make a real `fetch` against it, and assert
 * the CLIENT span the instrumentation produces.
 *
 * This test lives in mcp-server because mcp-core MUST NOT depend on
 * `@opentelemetry/instrumentation-*` (Plan 8 critical rule #5).
 *
 * Full end-to-end parent-child verification through buildServer + msw is
 * currently infeasible (see the it.skip below).
 */

const undiciInstrumentation = new UndiciInstrumentation({
  ignoreRequestHook: () => false,
  requestHook: (span, req) => {
    // Mirrors mcp-server/src/otel.ts. The local server cannot answer on
    // discord.com so the test simulates the origin via a custom header.
    const headersStr = Array.isArray(req.headers) ? req.headers.join('') : String(req.headers);
    if (headersStr.includes('x-fake-discord-origin')) {
      const route = redactRoute(req.path);
      span.setAttribute('discord.route', `${req.method} ${route}`);
      span.setAttribute('url.full', `${req.origin}${route}`);
      span.setAttribute('url.path', route);
    }
  },
});

let httpServer: HttpServer;
let baseUrl: string;
let spanExporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let meterProvider: MeterProvider;

beforeAll(async () => {
  // Local stub Discord-shaped endpoint. Returns 200 immediately.
  httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
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
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  meterProvider = new MeterProvider();
  metrics.setGlobalMeterProvider(meterProvider);
  undiciInstrumentation.setTracerProvider(tracerProvider);
  undiciInstrumentation.setMeterProvider(meterProvider);
  undiciInstrumentation.enable();
});

afterEach(async () => {
  undiciInstrumentation.disable();
  trace.disable();
  metrics.disable();
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
});

describe('UndiciInstrumentation integration (Plan 8 B.5)', () => {
  it('emits a CLIENT span for an undici fetch against a local server', async () => {
    const res = await fetch(`${baseUrl}/channels/123456789012345678/messages/987654321098765432`);
    await res.text();

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const client = spans.find((s) => s.kind === 2 /* SpanKind.CLIENT */);
    expect(client, 'expected a CLIENT span from UndiciInstrumentation').toBeDefined();
    const c = client as ReadableSpan;
    // url.full / http.request.method / http.response.status_code are
    // standard semantic conventions the upstream instrumentation sets.
    expect(c.attributes['http.request.method']).toBe('GET');
    expect(c.attributes['http.response.status_code']).toBe(200);
    expect(typeof c.attributes['url.full']).toBe('string');
  });

  it('applies the discord.route attribute via the requestHook (B.1 contract)', async () => {
    const res = await fetch(`${baseUrl}/channels/123456789012345678/messages/987654321098765432`, {
      headers: { 'x-fake-discord-origin': '1' },
    });
    await res.text();

    const client = spanExporter.getFinishedSpans().find((s) => s.kind === 2);
    expect(client).toBeDefined();
    expect(client?.attributes['discord.route']).toBe('GET /channels/:id/messages/:id');
  });

  it('keeps webhook tokens out of every span attribute (B2-04)', async () => {
    // Webhook tokens are bearer credentials living in the URL PATH, so the
    // standard url.full / url.path attributes would ship them to the tracing
    // backend verbatim. The requestHook must overwrite them, not just add
    // discord.route alongside.
    const token = 'S3cr3tWebhookTokenDoNotLeak';
    const res = await fetch(`${baseUrl}/api/v10/webhooks/123456789012345678/${token}`, {
      headers: { 'x-fake-discord-origin': '1' },
    });
    await res.text();

    const client = spanExporter.getFinishedSpans().find((s) => s.kind === 2);
    expect(client).toBeDefined();
    for (const [key, value] of Object.entries((client as ReadableSpan).attributes)) {
      expect(String(value), `span attribute ${key} leaked the webhook token`).not.toContain(token);
    }
    expect(client?.attributes['url.path']).toBe('/api/v10/webhooks/:id/:token');
  });

  it('respects ignoreRequestHook=true to suppress self-traces', async () => {
    // Re-install with a hook that drops every request — emulates the
    // OTLP exporter URL filter used by mcp-server/src/otel.ts.
    undiciInstrumentation.disable();
    const dropping = new UndiciInstrumentation({ ignoreRequestHook: () => true });
    dropping.setTracerProvider(tracerProvider);
    dropping.setMeterProvider(meterProvider);
    dropping.enable();

    const res = await fetch(`${baseUrl}/v1/traces`);
    await res.text();

    const client = spanExporter.getFinishedSpans().find((s) => s.kind === 2);
    expect(client, 'self-trace must not produce a CLIENT span').toBeUndefined();

    dropping.disable();
  });

  // TODO (Plan 12 Phase C.5): full end-to-end parent-child verification
  // through buildServer + msw is currently infeasible. msw patches global
  // fetch / ClientRequest while UndiciInstrumentation hooks dispatch at a
  // lower layer. Either the mock fires (msw wins → no undici span) or the
  // dispatch hook fires (msw bypassed → no mocked Discord response). In
  // production the SDK sees real undici and both spans appear under the
  // same trace_id.
  //
  // Converted from `it.skip` to `it.todo` so it surfaces in vitest's todo
  // list (intentional future work) instead of the skipped count
  // (operational warning). Re-enable once one of:
  //  - msw exposes a dispatch-aware interceptor compatible with undici
  //    instrumentation (tracked upstream — https://github.com/mswjs/msw).
  //  - we add a stand-alone HTTP fixture (similar to the local server in
  //    this file) under buildServer's REST instance instead of msw.
  it.todo('emits parent SERVER + child CLIENT span under one trace via buildServer');
});
