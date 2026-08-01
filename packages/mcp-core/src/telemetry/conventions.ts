/**
 * Semantic-convention attribute keys used by discord-mcp telemetry.
 *
 * Span and metric attribute names are stable contracts: changing one is
 * a breaking observability change for downstream dashboards/alerts.
 * Centralizing them here makes drift visible.
 *
 * `mcp.*` keys are project-private - there is no published OTel namespace
 * for MCP yet. We keep the shape close to the OTel rpc.* conventions for
 * forward compatibility.
 */
import packageJson from '../../package.json' with { type: 'json' };

// --- Tool / call attributes ---
export const ATTR_MCP_TOOL_NAME = 'mcp.tool.name';
export const ATTR_MCP_TOOL_CATEGORY = 'mcp.tool.category';
export const ATTR_MCP_TOOL_IDEMPOTENT = 'mcp.tool.idempotent';
export const ATTR_MCP_REQUEST_ID = 'mcp.request_id';
export const ATTR_MCP_TRANSPORT = 'mcp.transport';

// --- Result / status attributes ---
// "ok" | "error" | "tool_error"
export const ATTR_MCP_TOOL_STATUS = 'status';
export const ATTR_MCP_ERROR_CODE = 'mcp.error.code';

// --- Metric names ---
export const METRIC_TOOL_DURATION = 'mcp.tool.duration_ms';
export const METRIC_TOOL_CALLS = 'mcp.tool.calls';
export const METRIC_TOOL_ERRORS = 'mcp.tool.errors';

// --- Resilience metrics (Plan 8 Phase D) ---
// Circuit breaker state transitions; label `to_state` ∈ {open, half-open, closed}.
export const METRIC_CIRCUIT_TRANSITIONS = 'mcp.circuit.transitions';
// Bulkhead rejections (over-limit, fast-rejected because queueSize=0).
export const METRIC_BULKHEAD_REJECTED = 'mcp.bulkhead.rejected.count';
// Dead-letter (terminal failures after retries exhausted); label `error.type`.
export const METRIC_DEADLETTER = 'mcp.deadletter.count';
export const ATTR_CIRCUIT_TO_STATE = 'to_state';
export const ATTR_ERROR_TYPE = 'error.type';

// --- Tracer / Meter identity (also used by middleware) ---
export const TELEMETRY_INSTRUMENTATION_NAME = '@discord-mcp/core';
export const TELEMETRY_INSTRUMENTATION_VERSION: string = packageJson.version;
