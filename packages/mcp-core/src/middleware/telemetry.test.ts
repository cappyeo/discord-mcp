import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MiddlewareContext } from './compose.js';
import { telemetryMiddleware } from './telemetry.js';

const tool = {
  name: 'messages_send',
  category: 'messages',
  idempotent: false,
};

function makeCtx(): MiddlewareContext<unknown> {
  return {
    tool,
    args: { channel_id: '111', content: 'hi' },
    meta: new Map(),
  };
}

describe('telemetryMiddleware', () => {
  let spanExporter: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;
  let tracerProvider: BasicTracerProvider;
  let meterProvider: MeterProvider;
  let metricReader: PeriodicExportingMetricReader;

  beforeEach(() => {
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);

    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      // Long enough to never auto-fire during the test; we force-collect.
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [metricReader] });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    trace.disable();
    metrics.disable();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });

  it('creates a span with mcp.tool.<name> and the expected attributes', async () => {
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0] as ReadableSpan;
    expect(s.name).toBe('mcp.tool.messages_send');
    expect(s.attributes['mcp.tool.name']).toBe('messages_send');
    expect(s.attributes['mcp.tool.category']).toBe('messages');
    expect(s.attributes['mcp.tool.idempotent']).toBe(false);
    expect(s.attributes['mcp.transport']).toBe('stdio');
  });

  it('ends the span with status=OK when next() resolves with isError=false', async () => {
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));

    const s = spanExporter.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(1); // SpanStatusCode.OK
  });

  it('ends the span with status=ERROR and recordException when next() throws', async () => {
    const mw = telemetryMiddleware();
    const boom = new Error('boom');
    await expect(
      mw.onCallTool!(makeCtx(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const s = spanExporter.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(s.status.message).toBe('boom');
    expect(s.events.some((ev) => ev.name === 'exception')).toBe(true);
  });

  it('ends the span with status=ERROR when result.isError is true', async () => {
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: true, content: [] }));

    const s = spanExporter.getFinishedSpans()[0]!;
    expect(s.status.code).toBe(2);
    expect(s.status.message).toBe('tool returned isError');
  });

  it('records duration histogram + calls/errors counters', async () => {
    const mw = telemetryMiddleware();
    // success
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));
    // tool_error
    await mw.onCallTool!(makeCtx(), async () => ({ isError: true, content: [] }));
    // thrown error
    await expect(
      mw.onCallTool!(makeCtx(), async () => {
        throw new Error('oops');
      }),
    ).rejects.toBeInstanceOf(Error);

    // Force the periodic reader to flush.
    await metricReader.forceFlush();

    const collected = metricExporter.getMetrics();
    expect(collected.length).toBeGreaterThan(0);
    const all = collected.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));

    const duration = all.find((m) => m.descriptor.name === 'mcp.tool.duration_ms');
    expect(duration).toBeDefined();
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(duration?.dataPoints.length).toBe(3); // 3 status labels: ok, tool_error, error

    const calls = all.find((m) => m.descriptor.name === 'mcp.tool.calls');
    expect(calls).toBeDefined();
    const callPoints = calls?.dataPoints ?? [];
    const callsByStatus = new Map(
      callPoints.map((p) => [p.attributes.status as string, p.value as number]),
    );
    expect(callsByStatus.get('ok')).toBe(1);
    expect(callsByStatus.get('tool_error')).toBe(1);
    expect(callsByStatus.get('error')).toBe(1);

    const errs = all.find((m) => m.descriptor.name === 'mcp.tool.errors');
    expect(errs).toBeDefined();
    const errPoints = errs?.dataPoints ?? [];
    const errsByStatus = new Map(
      errPoints.map((p) => [p.attributes.status as string, p.value as number]),
    );
    expect(errsByStatus.get('tool_error')).toBe(1);
    expect(errsByStatus.get('error')).toBe(1);
    expect(errsByStatus.get('ok')).toBeUndefined();
  });

  it('includes mcp.tool.category as a label on histogram + counters (Plan 8 B.4)', async () => {
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));

    await metricReader.forceFlush();
    const collected = metricExporter.getMetrics();
    const all = collected.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));

    // Every metric series for our single call should carry the
    // category label exactly once.
    for (const name of ['mcp.tool.duration_ms', 'mcp.tool.calls']) {
      const m = all.find((x) => x.descriptor.name === name);
      expect(m, `missing metric ${name}`).toBeDefined();
      const point = m?.dataPoints[0];
      expect(point, `${name} has no data points`).toBeDefined();
      expect(point?.attributes['mcp.tool.name']).toBe('messages_send');
      expect(point?.attributes['mcp.tool.category']).toBe('messages');
    }
  });

  it('emits an mcp.tool.args span event with redacted args (Plan 8 F.2)', async () => {
    const mw = telemetryMiddleware();
    // messages_send.content is in SENSITIVE_KEYS_BY_TOOL → must be
    // replaced with the [REDACTED:Nch] marker before reaching the
    // span attribute. Raw "secret data" must NOT appear anywhere.
    const ctx = {
      tool,
      args: { channel_id: '111', content: 'secret data' },
      meta: new Map(),
    };
    await mw.onCallTool!(ctx, async () => ({ isError: false, content: [] }));

    const s = spanExporter.getFinishedSpans()[0]!;
    const ev = s.events.find((e) => e.name === 'mcp.tool.args');
    expect(ev, 'mcp.tool.args event missing').toBeDefined();
    const redactedJson = ev?.attributes?.['mcp.args.redacted'] as string;
    expect(redactedJson).toBeDefined();
    // Raw secret must NOT appear in the JSON.
    expect(redactedJson).not.toContain('secret data');
    // The marker (length-aware) must be present.
    expect(redactedJson).toContain('[REDACTED:11ch]');
    // Non-sensitive arg passes through.
    expect(redactedJson).toContain('"channel_id":"111"');
  });

  it('does not inspect args when the span is non-recording', async () => {
    trace.disable();
    const args = Object.defineProperty({}, 'content', {
      get: () => {
        throw new Error('non-recording spans must skip redaction');
      },
      enumerable: true,
    });
    const mw = telemetryMiddleware();

    await expect(
      mw.onCallTool!({ ...makeCtx(), args }, async () => ({ isError: false, content: [] })),
    ).resolves.toMatchObject({ isError: false });
    await metricReader.forceFlush();
    const all = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const calls = all.find((metric) => metric.descriptor.name === 'mcp.tool.calls');
    expect(calls?.dataPoints[0]?.value).toBe(1);
  });

  it('keeps metrics live when a middleware instance outlives a provider replacement', async () => {
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));
    metrics.disable();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));

    const replacementExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const replacementReader = new PeriodicExportingMetricReader({
      exporter: replacementExporter,
      exportIntervalMillis: 60_000,
    });
    const replacementProvider = new MeterProvider({ readers: [replacementReader] });
    metrics.setGlobalMeterProvider(replacementProvider);
    try {
      await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));
      await replacementReader.forceFlush();
      const all = replacementExporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
      const calls = all.find((metric) => metric.descriptor.name === 'mcp.tool.calls');
      expect(calls?.dataPoints[0]?.value).toBe(1);
    } finally {
      metrics.disable();
      await replacementProvider.shutdown();
    }
  });

  it('does NOT include mcp.request_id as a metric label (cardinality guard)', async () => {
    // Even when the middleware is called from a request context that
    // would set request_id on the span, the metric labels must not
    // include it. (Here we have no als context active, so the absence
    // is trivial; the contract still has to hold for future als
    // wiring.)
    const mw = telemetryMiddleware();
    await mw.onCallTool!(makeCtx(), async () => ({ isError: false, content: [] }));

    await metricReader.forceFlush();
    const collected = metricExporter.getMetrics();
    const all = collected.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));

    for (const name of ['mcp.tool.duration_ms', 'mcp.tool.calls']) {
      const m = all.find((x) => x.descriptor.name === name);
      const point = m?.dataPoints[0];
      expect(point?.attributes).toBeDefined();
      expect(point?.attributes['mcp.request_id']).toBeUndefined();
    }
  });
});
