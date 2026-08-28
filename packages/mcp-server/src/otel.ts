import {
  type AuditEvent,
  type AuditLogEmitter,
  buildResource,
  type Config,
  redactRoute,
} from '@discord-mcp/core';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { type IMetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ConsoleSpanExporter,
  ParentBasedSampler,
  type Sampler,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

export interface OtelHandle {
  /** Flush all pending spans/metrics/logs and detach the global providers. */
  shutdown: () => Promise<void>;
  /** Present when the configured audit sink can emit through OTLP logs. */
  auditEmitter?: AuditLogEmitter;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const METRIC_EXPORT_INTERVAL_MS = 30_000;
const LOG_EXPORT_INTERVAL_MS = 1_000;
const LOG_EXPORT_TIMEOUT_MS = 5_000;
const LOG_MAX_QUEUE_SIZE = 1_024;
const LOG_MAX_EXPORT_BATCH_SIZE = 128;

async function boundedShutdown(shutdown: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Parses a comma-separated `k=v` string into a header map.
 * Empty/whitespace pairs are skipped silently. Used for
 * OTEL_EXPORTER_OTLP_HEADERS.
 */
export function parseHeaders(s: string | undefined): Record<string, string> {
  if (s === undefined || s.trim() === '') return {};
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k.length > 0) out[k] = v;
  }
  return out;
}

function buildSampler(config: Config): Sampler {
  const arg = config.OTEL_TRACES_SAMPLER_ARG;
  switch (config.OTEL_TRACES_SAMPLER) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(arg);
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(arg) });
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

function buildTraceExporter(config: Config): SpanExporter | null {
  if (config.OTEL_CONSOLE_EXPORTER) return new ConsoleSpanExporter();
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) return null;
  return new OTLPTraceExporter({
    url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    headers: parseHeaders(config.OTEL_EXPORTER_OTLP_HEADERS),
  });
}

function buildMetricReader(config: Config): IMetricReader | null {
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) return null;
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
      headers: parseHeaders(config.OTEL_EXPORTER_OTLP_HEADERS),
    }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  });
}

/**
 * Build the explicit audit logs processor. The queue and batch limits are
 * deliberately bounded: a collector outage may drop audit records, but it
 * must not grow the bot process without limit or block a Discord mutation.
 */
function buildAuditLogProcessor(config: Config): LogRecordProcessor | null {
  if (
    !config.MCP_AUDIT_ENABLED ||
    config.MCP_AUDIT_SINK !== 'otlp' ||
    config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
  ) {
    return null;
  }
  const exporter = new OTLPLogExporter({
    url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`,
    headers: parseHeaders(config.OTEL_EXPORTER_OTLP_HEADERS),
    concurrencyLimit: 1,
  });
  return new BatchLogRecordProcessor({
    exporter,
    maxQueueSize: LOG_MAX_QUEUE_SIZE,
    maxExportBatchSize: LOG_MAX_EXPORT_BATCH_SIZE,
    scheduledDelayMillis: LOG_EXPORT_INTERVAL_MS,
    exportTimeoutMillis: LOG_EXPORT_TIMEOUT_MS,
  });
}

export interface AuditLogRecord {
  readonly severityNumber: SeverityNumber;
  readonly severityText: string;
  readonly body: string;
  readonly attributes: Readonly<Record<string, string | boolean>>;
}

/** Convert a redacted core event to the bounded OTel log shape. */
export function buildAuditLogRecord(event: AuditEvent): AuditLogRecord {
  return {
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    // Keep the full redacted event in the body for faithful audit replay;
    // only bounded routing fields become attributes.
    body: JSON.stringify({ level: 'audit', ...event }),
    attributes: {
      'mcp.audit.tool': event.tool,
      'mcp.audit.category': event.category,
      'mcp.audit.status': event.status,
      'mcp.audit.transport': event.transport,
      'mcp.audit.idempotent': event.idempotent,
      ...(event.request_id.length === 0 ? {} : { 'mcp.audit.request_id': event.request_id }),
      ...(event.result_code === undefined ? {} : { 'mcp.audit.result_code': event.result_code }),
    },
  };
}

function buildAuditEmitter(
  processor: LogRecordProcessor | null,
  config: Config,
): AuditLogEmitter | undefined {
  if (processor === null) return undefined;
  const logger = logs.getLogger('discord-mcp.audit', config.OTEL_SERVICE_VERSION);
  const provider = logs.getLoggerProvider() as {
    forceFlush?: (options?: { timeoutMillis?: number }) => Promise<void>;
  };
  return {
    emit(event: AuditEvent): void {
      // `redactArgs` already ran in core's audit middleware before this
      // boundary; this function only serializes the already-safe event.
      logger.emit(buildAuditLogRecord(event));
    },
    async forceFlush(): Promise<void> {
      if (provider.forceFlush === undefined) return;
      await provider.forceFlush({ timeoutMillis: LOG_EXPORT_TIMEOUT_MS });
    },
  };
}

/**
 * Returns true when the URL points at an OTLP collector path that the
 * SDK itself emits to. Tracing those would create an infinite loop:
 * each export request would itself produce a span, which the next
 * batch flushes, which produces a span, etc.
 *
 * Match is substring-based to cover both /v1/traces and any collector
 * proxy variants (e.g. with prefix paths).
 */
export function isOtlpSelfTrace(url: string): boolean {
  return url.includes('/v1/traces') || url.includes('/v1/metrics') || url.includes('/v1/logs');
}

/**
 * Undici span decorator for Discord REST calls.
 *
 * Exported so tests exercise THIS function rather than a copy of its body.
 * The assertion it carries is credential-disclosure prevention: a test that
 * re-declares the hook inline passes even after this one regresses.
 *
 * Two jobs:
 *  - tag the call with a normalized `discord.route` so dashboards can group by
 *    route shape without a per-id metric series;
 *  - OVERWRITE the standard `url.full` / `url.path` attributes, not merely
 *    supplement them. Webhook and interaction tokens live in the Discord URL
 *    *path*, so the raw values ship bearer credentials to the tracing backend.
 *    `requestHook` runs after the span is started with its initial attributes,
 *    so this write wins.
 *
 * MATCHING IS ON HOST OR PATH SHAPE, NEVER ON `origin + path`. undici's
 * `request.origin` is scheme://host with NO path - upstream reconstructs the
 * URL as `new URL(request.path, request.origin)`. An earlier version of this
 * gate tested `origin.includes('discord.com/api')`, which can never be true,
 * so the hook silently did nothing in production while its test passed by
 * handing it an origin undici never produces.
 *
 * The path-shape arm also covers `DISCORD_API_BASE_URL` pointing at a
 * self-hosted proxy: the credential is in the path either way, so a
 * host-only rule would fail open exactly where the operator is least likely
 * to notice.
 */
const DISCORD_HOST = /(^|\.)discord(app)?\.com$/i;
/** `/webhooks/{id}/{token}` and `/interactions/{id}/{token}` carry a credential. */
const CREDENTIAL_PATH = /\/(webhooks|interactions)\/\d{17,20}\/[^/?#]+/i;

export function discordRequestHook(
  span: { setAttribute: (k: string, v: string) => unknown },
  req: { origin: string; path: string; method: string },
): void {
  let isDiscordHost = false;
  try {
    isDiscordHost = DISCORD_HOST.test(new URL(req.origin).hostname);
  } catch {
    // Non-URL origin (shouldn't happen via undici) - fall back to path shape.
  }
  if (!isDiscordHost && !CREDENTIAL_PATH.test(req.path)) return;

  const route = redactRoute(req.path);
  span.setAttribute('discord.route', `${req.method} ${route}`);
  span.setAttribute('url.full', `${req.origin}${route}`);
  span.setAttribute('url.path', route);
}

function buildInstrumentations(): (UndiciInstrumentation | PinoInstrumentation)[] {
  return [
    new UndiciInstrumentation({
      ignoreRequestHook: (req) => isOtlpSelfTrace(`${req.origin}${req.path}`),
      requestHook: discordRequestHook,
    }),
    // Pino correlation: when a span is active, every pino log line
    // emitted under it gains trace_id/span_id fields, so traces and
    // logs can be joined in Loki/Tempo/Honeycomb without app changes.
    // Outside an active span the hook is not invoked, so log records
    // remain untouched (verified by instrumentation-pino's own tests).
    new PinoInstrumentation({
      logHook: (span, record) => {
        record.trace_id = span.spanContext().traceId;
        record.span_id = span.spanContext().spanId;
      },
    }),
  ];
}

/**
 * Boots the OpenTelemetry NodeSDK if `OTEL_ENABLED=true`, returns null
 * otherwise. The handle's `shutdown()` flushes spans, metrics, and (when
 * configured) audit logs with a 5s timeout; callers wire it to SIGTERM/SIGINT.
 *
 * Default behavior (OTEL_ENABLED unset) is identical to v0.7.0 - no
 * SDK boot, no global provider mutation.
 */
export function startOtel(config: Config): OtelHandle | null {
  if (!config.OTEL_ENABLED) return null;

  const traceExporter = buildTraceExporter(config);
  const metricReader = buildMetricReader(config);
  const auditLogProcessor = buildAuditLogProcessor(config);
  const instrumentations = buildInstrumentations();

  // If neither console nor OTLP is configured we still register the SDK
  // so the global tracer/meter providers exist (the middleware will use
  // them as no-op recorders). This keeps tool spans coherent in dev.
  //
  // Phase B: Undici + Pino auto-instrumentation are always enabled when
  // OTEL_ENABLED=true. UndiciInstrumentation captures every fetch/REST
  // call (including @discordjs/rest) as a CLIENT span; PinoInstrumentation
  // injects trace_id/span_id into log records inside an active span.
  const sdk = new NodeSDK({
    resource: buildResource(config),
    sampler: buildSampler(config),
    instrumentations,
    ...(traceExporter !== null && { traceExporter }),
    ...(metricReader !== null && { metricReaders: [metricReader] }),
    ...(auditLogProcessor !== null && { logRecordProcessors: [auditLogProcessor] }),
  });

  sdk.start();
  const auditEmitter = buildAuditEmitter(auditLogProcessor, config);

  return {
    ...(auditEmitter === undefined ? {} : { auditEmitter }),
    shutdown: async () => {
      try {
        await boundedShutdown(() => sdk.shutdown());
      } finally {
        // NodeSDK flushes providers but does not consistently disable every
        // instrumentation instance. Explicitly detach ours so an embedding
        // that starts a second server in-process does not duplicate spans.
        for (const instrumentation of instrumentations) instrumentation.disable();
      }
    },
  };
}
