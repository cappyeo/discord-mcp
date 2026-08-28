import {
  type Counter,
  context,
  type Histogram,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { tryGetCtx } from '../als/context.js';
import { redactArgs } from '../audit/redact.js';
import {
  ATTR_MCP_REQUEST_ID,
  ATTR_MCP_TOOL_CATEGORY,
  ATTR_MCP_TOOL_IDEMPOTENT,
  ATTR_MCP_TOOL_NAME,
  ATTR_MCP_TOOL_STATUS,
  ATTR_MCP_TRANSPORT,
  METRIC_TOOL_CALLS,
  METRIC_TOOL_DURATION,
  METRIC_TOOL_ERRORS,
  TELEMETRY_INSTRUMENTATION_NAME,
  TELEMETRY_INSTRUMENTATION_VERSION,
} from '../telemetry/conventions.js';
import type { ToolMiddleware } from './compose.js';

interface ToolResultLike {
  isError?: boolean;
}

function lookupTracerAndMeter(): {
  tracer: ReturnType<typeof trace.getTracer>;
  duration: Histogram;
  calls: Counter;
  errors: Counter;
} {
  // trace/metrics global providers fall back to no-op when no SDK is
  // registered (default v0.7.0 path), so this is safe to call even when
  // OTEL_ENABLED is false.
  const tracer = trace.getTracer(TELEMETRY_INSTRUMENTATION_NAME, TELEMETRY_INSTRUMENTATION_VERSION);
  const meter = metrics.getMeter(TELEMETRY_INSTRUMENTATION_NAME, TELEMETRY_INSTRUMENTATION_VERSION);
  const duration = meter.createHistogram(METRIC_TOOL_DURATION, {
    description: 'Wall-clock duration of MCP tool calls in milliseconds',
    unit: 'ms',
  });
  const calls = meter.createCounter(METRIC_TOOL_CALLS, {
    description: 'Total MCP tool calls, labelled by status (ok | error | tool_error)',
  });
  const errors = meter.createCounter(METRIC_TOOL_ERRORS, {
    description: 'MCP tool calls that ended in error, labelled by status',
  });
  return { tracer, duration, calls, errors };
}

/**
 * Outermost middleware: wraps every CallToolRequest in an OpenTelemetry
 * SERVER span and records duration/calls/errors metrics.
 *
 * Span name format: `mcp.tool.<tool_name>` to mirror the OTel rpc.* /
 * messaging.* naming conventions.
 *
 * The middleware runs `next()` inside `context.with(otelCtx, ...)` so
 * downstream child spans (e.g. REST calls in Phase B) attach to this
 * span as their parent.
 */
export function telemetryMiddleware(): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      const { tracer, duration, calls, errors } = lookupTracerAndMeter();
      const requestId = tryGetCtx()?.requestId;
      const transport = tryGetCtx()?.transport ?? 'stdio';

      // Span attributes: full set including (potentially per-call)
      // request_id. High cardinality is fine on a span but NOT on
      // metric labels.
      const spanAttrs: Record<string, string | boolean> = {
        [ATTR_MCP_TOOL_NAME]: ctx.tool.name,
        [ATTR_MCP_TOOL_CATEGORY]: ctx.tool.category,
        [ATTR_MCP_TOOL_IDEMPOTENT]: ctx.tool.idempotent,
        [ATTR_MCP_TRANSPORT]: transport,
      };
      if (requestId !== undefined) {
        spanAttrs[ATTR_MCP_REQUEST_ID] = requestId;
      }

      // Metric labels: bounded-cardinality only. tool.name (~209),
      // tool.category (~25), tool.idempotent (2), transport (1-3),
      // status (3). No request_id - that would explode the series
      // count and make the histograms useless.
      const metricLabels: Record<string, string | boolean> = {
        [ATTR_MCP_TOOL_NAME]: ctx.tool.name,
        [ATTR_MCP_TOOL_CATEGORY]: ctx.tool.category,
        [ATTR_MCP_TOOL_IDEMPOTENT]: ctx.tool.idempotent,
        [ATTR_MCP_TRANSPORT]: transport,
      };

      const span = tracer.startSpan(`mcp.tool.${ctx.tool.name}`, {
        kind: SpanKind.SERVER,
        attributes: spanAttrs,
      });

      // Phase F.2: emit a span EVENT carrying the redacted args. Using
      // an event (rather than a high-cardinality attribute on every
      // span) keeps the trace storage cost bounded and clearly marks
      // the payload as user-input. Redaction MUST go through
      // redactArgs(args, toolName) - it applies the per-tool sensitive
      // key map + global keys + length truncation. Span redaction
      // happens at the middleware boundary; tools never see telemetry.
      span.addEvent('mcp.tool.args', {
        'mcp.args.redacted': JSON.stringify(redactArgs(ctx.args, ctx.tool.name)),
      });

      const start = performance.now();
      const otelCtx = trace.setSpan(context.active(), span);

      try {
        const result = (await context.with(otelCtx, () => next())) as unknown;

        const elapsed = performance.now() - start;
        const isToolError = (result as ToolResultLike | null)?.isError === true;
        const status = isToolError ? 'tool_error' : 'ok';

        duration.record(elapsed, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });
        calls.add(1, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });

        if (isToolError) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool returned isError' });
          errors.add(1, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        return result as never;
      } catch (e) {
        const elapsed = performance.now() - start;
        const status = 'error';
        duration.record(elapsed, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });
        calls.add(1, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });
        errors.add(1, { ...metricLabels, [ATTR_MCP_TOOL_STATUS]: status });

        if (e instanceof Error) {
          span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        }
        throw e;
      } finally {
        span.end();
      }
    },
  };
}
