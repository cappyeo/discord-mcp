/**
 * Argument redactor for audit logs (Plan 8 Phase F).
 *
 * Phase F upgrades the Phase E placeholder with:
 *
 *   1. **Per-tool sensitive-key map** (`SENSITIVE_KEYS_BY_TOOL`) - explicit
 *      allowlist keyed by tool name. Tools NOT in the map fall back to
 *      the global rules only (length truncation + global key set). This
 *      is intentionally allowlist-style: new tools added in future plans
 *      MUST opt in to per-tool redaction. We prefer leaving an arg in
 *      the audit record over silently dropping it for a tool nobody
 *      knew to add to the map.
 *   2. **Recursive walk** - nested objects and arrays are descended.
 *      Per-tool keys match at any depth, global sensitive keys match at
 *      any depth, and string truncation applies to every leaf string.
 *   3. **Length-aware redaction marker** -
 *      `[REDACTED:${len}ch]` for strings (preserves the size signal) and
 *      `[REDACTED:value]` for non-string scalars / objects so the audit
 *      record still hints at the original shape.
 *
 * Truncation policy (preserved from Phase E): any leaf string longer
 * than `MAX_LEN` is shortened to `TRUNCATE_TO` characters with the
 * suffix `...[TRUNCATED]`. Caps message bodies, embed JSON, long IDs.
 */

const SENSITIVE_KEYS_GLOBAL = new Set([
  'token',
  'bearer_token',
  'interaction_token',
  'auth',
  'password',
  'secret',
]);

/**
 * Shape-aware fallback for credential-looking keys the global set does not
 * name explicitly (`*_token`, `*_secret`, `*password*`). Keeps a newly added
 * tool arg from leaking a live credential before anyone updates the set.
 */
function isSensitiveKey(lk: string): boolean {
  return (
    SENSITIVE_KEYS_GLOBAL.has(lk) ||
    lk.endsWith('_token') ||
    lk.endsWith('_secret') ||
    lk.includes('password')
  );
}

/**
 * Per-tool sensitive-key map (allowlist).
 *
 * Each entry lists arg-names whose values must be redacted for that
 * specific tool. Tools NOT in this map only get global redaction +
 * length truncation. New tools added in future plans must add their
 * own entry to opt in to per-tool redaction.
 */
const SENSITIVE_KEYS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  messages_send: new Set(['content']),
  messages_edit: new Set(['content']),
  // length only, no IDs leaked - the redactor will replace the array
  // with `[REDACTED:${arr.length}ch]`-style marker via the value path.
  messages_bulk_delete: new Set(['message_ids']),
  // `payload_json` carries the same body as `content`/`embeds`/… as an opaque
  // JSON string. Redacted wholesale rather than parsed: parsing an attacker-
  // shaped blob to redact its fields would be more code and more failure modes
  // than dropping the value, and the audit record only needs the size signal.
  webhooks_execute: new Set(['content', 'embeds', 'components', 'attachments', 'payload_json']),
  webhooks_edit_message: new Set(['content', 'embeds', 'components', 'payload_json']),
  components_v2_send: new Set(['content', 'components']),
  components_v2_edit: new Set(['components']),
  components_v2_send_from_template: new Set(['vars']),
  intelligence_summarize_channel: new Set(['messages', 'channel_messages']),
  intelligence_classify_messages: new Set(['messages']),
  intelligence_draft_response: new Set(['conversation', 'context']),
  intelligence_moderate_content: new Set(['content', 'text']),
  intelligence_extract_entities: new Set(['text', 'content']),
  interactions_create_response: new Set(['data']),
  interactions_edit_original_response: new Set(['content', 'embeds', 'components', 'payload_json']),
  interactions_create_followup: new Set(['content', 'embeds', 'components', 'payload_json']),
  interactions_edit_followup: new Set(['content', 'embeds', 'components', 'payload_json']),
  // `mcp_pipeline` is deliberately absent: its sensitive values live in
  // `steps[].args`, which `redactPipelineArgs` redacts under each step's own
  // tool rules. A flat key set here could not do that.
};

const MAX_LEN = 200;
const TRUNCATE_TO = 100;
const TRUNCATE_SUFFIX = '...[TRUNCATED]';

function truncateString(value: string): string {
  if (value.length <= MAX_LEN) return value;
  return value.slice(0, TRUNCATE_TO) + TRUNCATE_SUFFIX;
}

/**
 * Build the `[REDACTED:...]` marker for a redacted value, preserving a
 * size hint:
 *   - strings → `[REDACTED:${len}ch]` (length in characters)
 *   - everything else → `[REDACTED:value]`
 *
 * The string-length encoding is what the integration tests assert
 * against (e.g. `content: "secret data"` → `[REDACTED:11ch]`).
 */
function redactionMarker(value: unknown): string {
  if (typeof value === 'string') return `[REDACTED:${value.length}ch]`;
  return '[REDACTED:value]';
}

/**
 * Recursive walker. Descends into plain objects and arrays. For each
 * key/value pair:
 *   1. If the key matches `isSensitiveKey` OR the per-tool set, replace
 *      with `redactionMarker(value)`.
 *   2. Otherwise, descend into the value (recurse on objects/arrays,
 *      truncate strings, pass other scalars through).
 *
 * `null`, `undefined`, numbers, booleans, bigints pass through unchanged
 * outside of the sensitive-key path.
 */
function walk(value: unknown, perToolKeys: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, perToolKeys));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (isSensitiveKey(lk) || perToolKeys.has(lk) || perToolKeys.has(k)) {
      out[k] = redactionMarker(v);
      continue;
    }
    out[k] = walk(v, perToolKeys);
  }
  return out;
}

/**
 * `mcp_pipeline` args are `{steps:[{tool, args}]}`, where each step's `args`
 * are another tool's arguments. Walking them under the pipeline's own key set
 * would audit them in full - `messages_send` run through a pipeline would log
 * the content a direct call redacts. So each step's `args` is re-redacted
 * under its own `tool`'s rules; a step whose `tool` is not a string (malformed
 * input, rejected later by validation) has its `args` dropped wholesale.
 *
 * Recursion terminates: `redactArgs` only re-enters here for a nested
 * `mcp_pipeline` step, and nesting is bounded by the finite input depth.
 */
function redactPipelineArgs(args: Record<string, unknown>): Record<string, unknown> {
  const noKeys = new Set<string>();
  const out = walk(args, noKeys) as Record<string, unknown>;
  if (!Array.isArray(args.steps)) return out;

  out.steps = args.steps.map((step: unknown) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      return walk(step, noKeys);
    }
    const entries = step as Record<string, unknown>;
    const redactedStep = walk(entries, noKeys) as Record<string, unknown>;
    if ('args' in entries) {
      redactedStep.args =
        typeof entries.tool === 'string'
          ? redactArgs(entries.args, entries.tool)
          : redactionMarker(entries.args);
    }
    return redactedStep;
  });
  return out;
}

/**
 * Redact tool args for inclusion in audit records or span events.
 *
 * @param args     Tool arguments as received by the middleware (already
 *                 validated). Non-object inputs return an empty record.
 * @param toolName Tool name - used to look up `SENSITIVE_KEYS_BY_TOOL`.
 *                 Tools missing from the map only get global redaction
 *                 + length truncation (allowlist semantics).
 */
export function redactArgs(args: unknown, toolName: string): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }
  if (toolName === 'mcp_pipeline') {
    return redactPipelineArgs(args as Record<string, unknown>);
  }
  const perToolKeys = SENSITIVE_KEYS_BY_TOOL[toolName] ?? new Set<string>();
  const walked = walk(args, perToolKeys) as Record<string, unknown>;
  return walked;
}

/**
 * Test-only export: lets the redact tests assert that every tool listed
 * in the per-tool map is exercised. NOT part of the public API.
 */
export const __SENSITIVE_KEYS_BY_TOOL_FOR_TESTS = SENSITIVE_KEYS_BY_TOOL;
