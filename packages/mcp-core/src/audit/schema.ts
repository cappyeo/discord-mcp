/**
 * Audit event schema (Plan 8 Phase E).
 *
 * One AuditEvent is emitted per **mutating** tool call (`idempotent: false`).
 * Read-only / idempotent tools are skipped - see middleware/audit.ts. The
 * event is JSON-line-encoded and routed through an `AuditSink` (stderr,
 * file, OTLP logs, or no-op).
 *
 * Field semantics:
 *   - `timestamp`: ISO-8601 UTC (`new Date().toISOString()`).
 *   - `request_id`: per-call UUID from the AsyncLocalStorage request
 *     context. Empty string if no context is active.
 *   - `tool`, `category`, `idempotent`: copied from MiddlewareToolInfo.
 *     `idempotent` is always `false` in practice (we skip the rest), but
 *     we keep the field for downstream consumers that filter by it.
 *   - `args_redacted`: tool args after `redactArgs(args, toolName)` -
 *     Phase E ships a placeholder global redactor (see audit/redact.ts);
 *     Phase F adds per-tool sensitive keys.
 *   - `status`:
 *       - `'success'`     - handler returned without `isError: true`.
 *       - `'tool_error'`  - handler returned `{ isError: true, ... }`
 *                           (structured error inside CallToolResult).
 *       - `'thrown'`      - handler threw a JS exception (re-thrown).
 *   - `result_code`: present only when `status !== 'success'`. Carries a
 *     short machine-readable hint (error.name for `'thrown'`, or the
 *     structured-error `code` for `'tool_error'` if available).
 *   - `duration_ms`: wall-clock from middleware enter to next() resolve
 *     or throw, measured via `performance.now()`.
 *   - `transport`: 'stdio' | 'http' (matches ToolRequestContext.transport).
 *   - `trace_id` / `span_id`: hex strings from
 *     `trace.getActiveSpan()?.spanContext()`. **Undefined when no active
 *     span** (e.g. OTel disabled), per plan §10 critical rule 4.
 */
export interface AuditEvent {
  readonly timestamp: string;
  readonly request_id: string;
  readonly tool: string;
  readonly category: string;
  readonly idempotent: boolean;
  readonly args_redacted: Record<string, unknown>;
  readonly status: 'success' | 'tool_error' | 'thrown';
  readonly result_code?: string;
  readonly duration_ms: number;
  readonly transport: string;
  readonly trace_id?: string;
  readonly span_id?: string;
}
