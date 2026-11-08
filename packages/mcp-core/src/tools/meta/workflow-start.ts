import { z } from 'zod';
import { getWorkflowEngine } from '../../workflows/registry.js';
import type { WorkflowInvokeContext } from '../../workflows/types.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

const target = z.object({
  profile_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe('Trusted bot profile binding; never a filesystem path.'),
  bot_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional()
    .describe('Expected bot identity binding.'),
  guild_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional()
    .describe('Target guild binding.'),
  channel_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional()
    .describe('Target channel binding.'),
});
const step = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});

export default defineTool({
  name: 'workflow_start',
  category: 'meta',
  description:
    '**Purpose**: Start a durable, target-bound workflow and return immediately with an operation ID. **Safety**: every step re-enters the normal tool middleware; nested workflows/pipelines are rejected. **Returns**: a private operation summary; use workflow_status, workflow_resume, or workflow_cancel.',
  inputSchema: {
    target: target.describe('Immutable profile and Discord target binding.'),
    steps: z.array(step).min(1).max(128).describe('At most 128 bounded steps.'),
    idempotency_key: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,128}$/)
      .optional()
      .describe('A stable key for this exact workflow. Reuse it after losing the response.'),
  },
  outputSchema: {
    id: z.string(),
    status: z.string(),
    target: target,
    current_step: z.number(),
    total_steps: z.number(),
    completed_steps: z.number(),
    cancel_requested: z.boolean(),
    updated_at: z.string(),
    failure: z.object({ code: z.string(), message: z.string() }).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const run = ctx as unknown as WorkflowInvokeContext;
    const engine = getWorkflowEngine(run);
    const result = await engine.start(args as never, run);
    return dualResult({
      text: `Workflow ${result.id}: ${result.status}.`,
      data: result,
    });
  },
});
