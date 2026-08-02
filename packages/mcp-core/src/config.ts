import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };

// Helper for truthy env strings - matches Plan 8 §5 boolean env-string convention.
const boolish = (def = false) =>
  z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true' || v === 'yes')
    .default(def);

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN appears too short to be a valid bot token'),
  DISCORD_DEFAULT_GUILD_ID: z
    .string()
    .regex(/^\d{17,20}$/, 'DISCORD_DEFAULT_GUILD_ID must be a 17-20 digit Discord snowflake')
    .optional(),
  ALLOWED_GUILDS: z
    .string()
    .trim()
    .regex(
      /^\d{17,20}(?:\s*,\s*\d{17,20})*$/,
      'ALLOWED_GUILDS must be a comma-separated list of 17-20 digit Discord snowflakes',
    )
    .optional(),
  // Required by `serve --http`, but optional for the default local stdio transport.
  DISCORD_MCP_ACCESS_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GATEWAY: boolish(false),

  // --- Least privilege ---
  // Comma-separated allowlist of tool categories. Unset (the default) means
  // every category is reachable. Names are validated against the categories
  // that actually exist when the server boots, so a typo fails fast with the
  // real options rather than silently disabling a whole surface.
  // The `meta` category is always reachable.
  MCP_CATEGORIES: z.string().optional(),

  // Controls only how much of the authorized tool catalog is advertised to
  // the model. `progressive` exposes search + risk-specific dispatchers while
  // calls still pass through MCP_CATEGORIES and the complete middleware chain.
  MCP_TOOL_SURFACE: z.enum(['full', 'progressive']).default('full'),

  // --- OpenTelemetry (Plan 8 Phase A) ---
  // Master switch. When false, mcp-server skips SDK boot entirely (default behavior).
  OTEL_ENABLED: boolish(false),
  OTEL_SERVICE_NAME: z.string().default('discord-mcp'),
  OTEL_SERVICE_VERSION: z.string().default(packageJson.version),
  // OTLP collector endpoint (e.g. http://localhost:4318). Optional - when unset
  // the SDK still boots (if OTEL_CONSOLE_EXPORTER=true) or stays inert.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_PROTOCOL: z
    .enum(['http/protobuf', 'http/json', 'grpc'])
    .default('http/protobuf'),
  // Comma-separated key=value pairs, e.g. "api-key=abc,env=prod".
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_TRACES_SAMPLER: z
    .enum([
      'always_on',
      'always_off',
      'traceidratio',
      'parentbased_always_on',
      'parentbased_always_off',
      'parentbased_traceidratio',
    ])
    .default('parentbased_always_on'),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
  // Pipe spans to stdout (debug aid). Honours JSON-RPC by routing to stderr in caller.
  OTEL_CONSOLE_EXPORTER: boolish(false),

  // --- Resilience (Plan 8 Phase C) ---
  // Retry is ON by default. Boolean transform uses `!== 'false'` so anything
  // other than the literal string 'false' (including unset → undefined) is true.
  MCP_RETRY_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default(true),
  MCP_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MCP_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(50).max(5000).default(200),
  MCP_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  MCP_RETRY_JITTER: z.enum(['none', 'full', 'decorrelated']).default('full'),
  MCP_TIMEOUT_DEFAULT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),

  // --- Resilience: circuit breaker + bulkhead (Plan 8 Phase D) ---
  // Circuit is ON by default. Same `!== 'false'` semantics as MCP_RETRY_ENABLED:
  // anything other than the literal string 'false' (incl. unset) is true.
  MCP_CIRCUIT_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default(true),
  MCP_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(3).max(100).default(10),
  MCP_CIRCUIT_HALF_OPEN_AFTER_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
  // Bulkhead: max in-flight Discord REST calls.  queueSize is hard-coded to 0
  // in policy.ts (fast-reject, no head-of-line blocking).  Min sane value is
  // 10 - see policy.ts JSDoc note on pipeline self-deadlock.
  MCP_BULKHEAD_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),

  // --- Audit logging (Plan 8 Phase E) ---
  // Audit is ON by default. Same `!== 'false'` semantics as the other
  // default-on flags: anything other than the literal string 'false'
  // (including unset → undefined) is true.
  MCP_AUDIT_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default(true),
  // Sink selector - see audit/sink.ts. `none` is identical to setting
  // MCP_AUDIT_ENABLED=false but reserved for explicit opt-out via sink config.
  MCP_AUDIT_SINK: z.enum(['stderr', 'file', 'otlp', 'none']).default('stderr'),
  // Path used by FileAuditSink. Optional - sink falls back to a default
  // (./discord-mcp-audit.jsonl) at runtime when undefined.
  MCP_AUDIT_FILE: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  if (
    parsed.data.ALLOWED_GUILDS !== undefined &&
    parsed.data.DISCORD_DEFAULT_GUILD_ID !== undefined &&
    !parsed.data.ALLOWED_GUILDS.split(',')
      .map((guildId) => guildId.trim())
      .includes(parsed.data.DISCORD_DEFAULT_GUILD_ID)
  ) {
    throw new Error(
      'Invalid configuration:\n  - DISCORD_DEFAULT_GUILD_ID: must be included in ALLOWED_GUILDS',
    );
  }
  return parsed.data;
}
