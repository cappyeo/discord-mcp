import { buildResource, type Config, redactRoute } from '@cappyeo/discord-mcp-core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
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
  /** Flush all pending spans/metrics and detach the global providers. */
  shutdown: () => Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const METRIC_EXPORT_INTERVAL_MS = 30_000;

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
 * `request.origin` is scheme://host with NO path — upstream reconstructs the
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
    // Non-URL origin (shouldn't happen via undici) — fall back to path shape.
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
 * otherwise. The handle's `shutdown()` flushes spans and metrics with a
 * 5s timeout; callers (stdio transport) wire it to SIGTERM/SIGINT.
 *
 * Default behavior (OTEL_ENABLED unset) is identical to v0.7.0 — no
 * SDK boot, no global provider mutation.
 */
export function startOtel(config: Config): OtelHandle | null {
  if (!config.OTEL_ENABLED) return null;

  const traceExporter = buildTraceExporter(config);
  const metricReader = buildMetricReader(config);

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
    instrumentations: buildInstrumentations(),
    ...(traceExporter !== null && { traceExporter }),
    ...(metricReader !== null && { metricReaders: [metricReader] }),
  });

  sdk.start();

  return {
    shutdown: async () => {
      await Promise.race([
        sdk.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    },
  };
}
