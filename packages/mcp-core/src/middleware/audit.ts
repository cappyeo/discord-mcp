import { trace } from '@opentelemetry/api';
import { tryGetCtx } from '../als/context.js';
import { redactArgs } from '../audit/redact.js';
import type { AuditEvent } from '../audit/schema.js';
import type { AuditSink } from '../audit/sink.js';
import type { ToolMiddleware } from './compose.js';

interface ToolResultLike {
  isError?: boolean;
  structuredContent?: { code?: unknown };
}

/**
 * Try to extract a short machine-readable code from a tool's
 * `CallToolResult` when `isError: true`. The structured-error format
 * (see errors/format.ts) places `code` inside `structuredContent`.
 * Returns `undefined` when no usable code is present so the AuditEvent
 * keeps `result_code` absent rather than emitting an empty string.
 */
function extractToolErrorCode(result: ToolResultLike | null | undefined): string | undefined {
  const code = result?.structuredContent?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Audit middleware (Plan 8 Phase E, Task E.3).
 *
 * **INNERMOST** in the chain - installed after telemetry / validate /
 * precondition. By design, audit only fires for actually-attempted
 * operations (after validation + preconditions pass). Blocked
 * operations should NOT generate audit noise - telemetry already
 * records them.
 *
 * Skips read-only / idempotent tools (`ctx.tool.idempotent === true`).
 * Mutating tools (`idempotent: false`) emit one AuditEvent per call:
 *
 *   - `success`     - handler returned without `isError: true`.
 *   - `tool_error`  - handler returned `{ isError: true, ... }`.
 *   - `thrown`      - handler threw a JS exception (we re-throw after
 *                     emitting).
 *
 * Trace correlation is OPTIONAL: when no active OTel span exists (e.g.
 * OTEL_ENABLED=false), `trace_id`/`span_id` are left **undefined** -
 * never empty string. See plan §10 critical rule 4.
 */
export function auditMiddleware(sink: AuditSink): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      // Skip read-only tools - see plan §10 Task E.3.
      if (ctx.tool.idempotent) {
        return next();
      }

      const requestId = tryGetCtx()?.requestId ?? '';
      const transport = tryGetCtx()?.transport ?? 'stdio';
      const argsRedacted = redactArgs(ctx.args, ctx.tool.name);
      const start = performance.now();

      // Active span (if any) - trace.getActiveSpan() returns undefined
      // when no SDK is registered or no parent span is on the stack.
      const span = trace.getActiveSpan();
      const spanCtx = span?.spanContext();
      const trace_id = spanCtx?.traceId;
      const span_id = spanCtx?.spanId;

      const buildEvent = (
        status: AuditEvent['status'],
        result_code: string | undefined,
      ): AuditEvent => {
        const event: AuditEvent = {
          timestamp: new Date().toISOString(),
          request_id: requestId,
          tool: ctx.tool.name,
          category: ctx.tool.category,
          idempotent: ctx.tool.idempotent,
          args_redacted: argsRedacted,
          status,
          duration_ms: performance.now() - start,
          transport,
          ...(result_code !== undefined ? { result_code } : {}),
          ...(trace_id !== undefined ? { trace_id } : {}),
          ...(span_id !== undefined ? { span_id } : {}),
        };
        return event;
      };

      try {
        const result = (await next()) as ToolResultLike | null;
        const isToolError = result?.isError === true;
        if (isToolError) {
          await sink.emit(buildEvent('tool_error', extractToolErrorCode(result)));
        } else {
          await sink.emit(buildEvent('success', undefined));
        }
        return result as never;
      } catch (e) {
        const code = e instanceof Error ? e.name : 'unknown';
        await sink.emit(buildEvent('thrown', code));
        throw e;
      }
    },
  };
}
