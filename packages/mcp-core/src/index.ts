import packageJson from '../package.json' with { type: 'json' };

// AsyncLocalStorage
export { getCtx, runWithCtx, type ToolRequestContext, tryGetCtx } from './als/context.js';
// Audit (Plan 8 Phase E)
export { redactArgs } from './audit/redact.js';
export type { AuditEvent } from './audit/schema.js';
export {
  type AuditSink,
  createAuditSink,
  DEFAULT_AUDIT_FILE,
  FileAuditSink,
  NoopAuditSink,
  OtlpAuditSink,
  StderrAuditSink,
} from './audit/sink.js';
// Capabilities
export { CapabilityRouter } from './capabilities/router.js';
export type { CapabilityFlag, ClientCapabilitiesSnapshot } from './capabilities/types.js';
export { type Config, loadConfig } from './config.js';
export { type FormatErrorContext, formatErrorForUser } from './errors/format.js';
// Errors
export {
  BulkheadFullError,
  CancelledError,
  CircuitOpenError,
  DiscordAuthError,
  DiscordClientError,
  DiscordCloudflareBlocked,
  DiscordError,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordRateLimitError,
  DiscordServerError,
  DiscordServerErrorImpl,
  DryRunPreview,
  GuildNotAllowedError,
  InternalError,
  ScopeRejectedError,
  ValidationError,
  type ValidationIssue,
} from './errors/index.js';
export {
  createGatewayClient,
  type GatewayClient,
  type GatewayClientDeps,
} from './gateway/client.js';
export { SubscriptionRegistry } from './gateway/subscription_registry.js';
export { createLogger } from './logger.js';
export { auditMiddleware } from './middleware/audit.js';
// Middleware
export {
  type CallNext,
  compose,
  type MiddlewareContext,
  type MiddlewareToolInfo,
  type ToolMiddleware,
} from './middleware/compose.js';
export { preconditionMiddleware } from './middleware/precondition.js';
export { telemetryMiddleware } from './middleware/telemetry.js';
export { validateMiddleware } from './middleware/validate.js';
export { Precondition } from './pieces/Precondition.js';
// Pieces
export { Tool, type ToolAnnotations, type ToolRunContext } from './pieces/Tool.js';
// Pipeline
export {
  executePipeline,
  type InvokeFn,
  type PipelineExecutorCtx,
  type PipelineResult,
  type Step,
  type StepResult,
} from './pipeline/executor.js';
export { evalCondition, interpolate, resolvePath } from './pipeline/interpolate.js';
// Preconditions
export { CategoryEnabled } from './preconditions/CategoryEnabled.js';
export { ConfirmRequired } from './preconditions/ConfirmRequired.js';
// REST resilience (Plan 8 Phase C)
export { classifyDiscordError, DiscordRetryableError } from './rest/errors.js';
export { buildPolicy } from './rest/policy.js';
export { type ClassifierFn, wrapRestWithResilience } from './rest/resilient.js';
export { type BuildServerDeps, type BuildServerResult, buildServer } from './server.js';
export { PreconditionStore } from './stores/PreconditionStore.js';
// Stores
export { ToolStore } from './stores/ToolStore.js';
// Telemetry (Plan 8 Phase A)
export * as TelemetryConventions from './telemetry/conventions.js';
export { redactRoute } from './telemetry/redact.js';
export { buildResource } from './telemetry/resource.js';
// Tool helpers
export { defineTool, type ToolDefinition } from './tools/_lib/defineTool.js';
export { type CursorPayload, decodeCursor, encodeCursor } from './tools/_lib/pagination.js';
export { type DualResultOpts, dualResult } from './tools/_lib/response.js';
export {
  ApplicationId,
  ChannelId,
  EmojiId,
  GuildId,
  MessageId,
  RoleId,
  Snowflake,
  UserId,
  WebhookId,
} from './tools/_lib/snowflake.js';
export {
  type MessageForWrap,
  type UntrustedKind,
  wrapMessages,
  wrapUntrusted,
} from './tools/_lib/untrusted.js';

/**
 * Package version, derived from package.json — the single source of truth.
 *
 * The explicit `: string` annotation is load-bearing: without it the emitted
 * .d.ts bakes a string *literal* type into the about-to-be-frozen public
 * surface, and a consumer writing `if (VERSION !== '1.0.0')` gets TS2367
 * (comparison appears unintentional) instead of a boolean.
 */
export const VERSION: string = packageJson.version;
