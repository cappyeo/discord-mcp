import { z } from 'zod';
import { planDiscordIntent } from '../../access/intent-plan.js';
import { LOCAL_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { PermissionString } from '../_lib/permissions.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

const AccessSchema = z.object({
  auth: z.string(),
  permissions: z.array(z.string()),
  intents: z.array(z.string()),
  scope: z.string(),
  hierarchy: z.string(),
});

const StepSchema = z.object({
  id: z.string(),
  action: z.enum(['prepare', 'write', 'verify']),
  tool: z.string(),
  purpose: z.string(),
  args: z.record(z.string(), z.unknown()),
  access: AccessSchema,
  depends_on: z.array(z.string()),
  requires_approval: z.boolean(),
});

/**
 * Read-only intent normalization front door. It produces a review artifact;
 * it is intentionally not a dispatcher and cannot execute any returned step.
 */
export default defineTool({
  name: 'discord_intent_plan',
  category: 'meta',
  description: [
    '**Purpose**: Normalize a small, explicit Discord outcome into a deterministic, reviewable plan.',
    '',
    '**Supported intents**: `lock_channel`, `announce`, `verify`, and `lock_and_announce` (natural-language separators and the bounded Vietnamese aliases `khóa kênh`, `thông báo`, `xác minh` are accepted).',
    '',
    '**Safety**: This tool is strictly read-only. Its planner performs no Discord REST call, grants no approval, and never executes the returned steps; normal server scope middleware may perform a read-only target lookup.',
    '',
    '**Returns**: A target-bound step list, aggregated access requirements, warnings, and a stable SHA-256 plan digest.',
  ].join('\n'),
  inputSchema: {
    intent: z.string().trim().min(1).max(80).describe('One supported explicit Discord intent.'),
    guild_id: GuildId.describe('Target guild snowflake.'),
    channel_id: ChannelId.describe('Target channel snowflake.'),
    announcement: z
      .string()
      .max(2000)
      .optional()
      .describe('Announcement text for announce intents.'),
    allow: PermissionString.optional().describe('Allow bitfield for a reviewed channel overwrite.'),
    deny: PermissionString.optional().describe('Deny bitfield for a reviewed channel overwrite.'),
  },
  outputSchema: {
    schema_version: z.literal('discord_intent_plan.v1'),
    status: z.enum(['ready', 'needs_input', 'unsupported']),
    intent: z.string().nullable(),
    target: z.object({ guild_id: GuildId, channel_id: ChannelId }),
    steps: z.array(StepSchema),
    access: z.object({ permissions: z.array(z.string()), scopes: z.array(z.string()) }),
    approval_boundary: z.enum(['per_write', 'none']),
    verification_step_id: z.string().nullable(),
    plan_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    warnings: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  access: LOCAL_ACCESS,
  idempotent: true,
  handler: async (args) => {
    const plan = planDiscordIntent({
      intent: args.intent,
      guild_id: args.guild_id,
      channel_id: args.channel_id,
      ...(args.announcement === undefined ? {} : { announcement: args.announcement }),
      ...(args.allow === undefined ? {} : { allow: args.allow }),
      ...(args.deny === undefined ? {} : { deny: args.deny }),
    });
    return dualResult({
      text:
        plan.status === 'ready'
          ? `Prepared read-only Discord intent plan \`${plan.plan_digest}\` with ${plan.steps.length} step(s). No Discord mutation was made.`
          : plan.status === 'needs_input'
            ? 'Intent needs additional input; no executable plan was produced and no Discord mutation was made.'
            : 'Intent is unsupported; no executable plan was produced and no Discord mutation was made.',
      data: plan,
    });
  },
});
