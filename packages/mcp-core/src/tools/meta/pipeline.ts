import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { executePipeline, type Step, type StepResult } from '../../pipeline/executor.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

interface RunCtxWithInvoke {
  readonly signal: AbortSignal;
  readonly invoke: (name: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult>;
}

const StepSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/i)
    .optional()
    .describe('Reference name for interpolation. Defaults to step_<index>.'),
  tool: z
    .string()
    .min(1)
    .describe('Tool name to call. Must exist; not mcp_pipeline (no recursion).'),
  args: z
    .record(z.string(), z.unknown())
    .describe('Tool arguments. String fields support {{step_id.path}} interpolation.'),
  save_as: z
    .string()
    .min(1)
    .optional()
    .describe('Save result under this variable name in addition to step ID.'),
  if: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Path to truthy check. Step skipped if path resolves falsy. Example: "{{step1.count}}".',
    ),
  continue_on_error: z
    .boolean()
    .default(false)
    .describe('If true, pipeline continues after this step fails. Default aborts.'),
});

export default defineTool({
  name: 'mcp_pipeline',
  category: 'meta',
  description: [
    '**Purpose**: Execute a sequence of MCP tool calls in one request. Variables from earlier steps interpolate into later steps via `{{step_id.path}}`.',
    '',
    '**When to use**: when a workflow needs ≥2 sequential calls (e.g., list channels → find by name → send message). Reduces N round-trips to 1.',
    '',
    '**When NOT to use**: parallel-safe independent calls — issue them as separate tools/call requests. Long-running batch ops — use the dedicated bulk tool (Plan 7+) so each operation can fail independently.',
    '',
    '**Step shape**: `{id?, tool, args, save_as?, if?, continue_on_error?}`. `args` may contain `{{step_id.path}}` placeholders. `if` is a path check; the step skips when the path resolves to falsy.',
    '',
    '**Example**:',
    '```',
    '{steps:[',
    '  {id:"channels", tool:"channels_list", args:{guild_id:"123456789012345678"}},',
    '  {id:"send",     tool:"messages_send", args:{channel_id:"{{channels.channels[0].id}}", content:"hi"}}',
    ']}',
    '```',
    '',
    '**Returns**: `{steps:[{id, tool, status, result?, error?, duration_ms}], variables, total_duration_ms, aborted}`. Each step status is `success | error | skipped`.',
    '',
    '**Limits**: max 20 steps per pipeline. Nested `mcp_pipeline` rejected (no recursion).',
  ].join('\n'),
  inputSchema: {
    steps: z.array(StepSchema).min(1).max(20).describe('Ordered steps. Max 20 per pipeline.'),
  },
  outputSchema: {
    steps: z.array(
      z.object({
        id: z.string(),
        tool: z.string(),
        status: z.enum(['success', 'error', 'skipped']),
        result: z.unknown().optional(),
        error: z
          .object({ code: z.string(), message: z.string(), retriable: z.boolean() })
          .optional(),
        duration_ms: z.number(),
      }),
    ),
    variables: z.record(z.string(), z.unknown()),
    total_duration_ms: z.number(),
    aborted: z.boolean(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const runCtx = ctx as RunCtxWithInvoke;
    const invoke = runCtx.invoke;

    const recursionViolation = args.steps.find((s) => s.tool === 'mcp_pipeline');
    if (recursionViolation !== undefined) {
      const stepResults: StepResult[] = args.steps.map((s, i) => {
        const id = s.id ?? `step_${i}`;
        if (s.tool === 'mcp_pipeline') {
          return {
            id,
            tool: s.tool,
            status: 'error',
            error: {
              code: 'PIPELINE_RECURSION',
              message: 'Nested mcp_pipeline calls are not permitted (v1).',
              retriable: false,
            },
            duration_ms: 0,
          };
        }
        return {
          id,
          tool: s.tool,
          status: 'skipped',
          duration_ms: 0,
        };
      });
      return dualResult({
        text: '**Pipeline rejected**: nested mcp_pipeline calls are not permitted.',
        data: {
          steps: stepResults,
          variables: {},
          total_duration_ms: 0,
          aborted: true,
        },
      });
    }

    const result = await executePipeline(args.steps as readonly Step[], invoke, {
      signal: runCtx.signal,
    });
    const summary =
      `**Pipeline ${result.aborted ? '⚠️ aborted' : '✅ complete'}** — ` +
      `${result.steps.filter((s) => s.status === 'success').length}/${result.steps.length} success` +
      ` (${result.total_duration_ms.toFixed(0)}ms)\n` +
      result.steps
        .map(
          (s) =>
            `- ${s.id} (${s.tool}) — ${s.status}${s.error !== undefined ? ` [${s.error.code}]` : ''} (${s.duration_ms.toFixed(0)}ms)`,
        )
        .join('\n');

    return dualResult({
      text: summary,
      data: {
        steps: result.steps.map((s) => ({ ...s })),
        variables: result.variables,
        total_duration_ms: result.total_duration_ms,
        aborted: result.aborted,
      },
    });
  },
});
