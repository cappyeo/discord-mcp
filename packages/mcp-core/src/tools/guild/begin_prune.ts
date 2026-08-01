import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId } from '../_lib/snowflake.js';

interface RawPrune {
  pruned: number | null;
}

export default defineTool({
  name: 'guild_begin_prune',
  category: 'guild',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Kick inactive members. **DESTRUCTIVE - kicked members must rejoin manually.**',
    '',
    '**When to use**:',
    '- Reduce inactive bloat in large communities.',
    '',
    '**`compute_prune_count`** (default true) returns the actual count; set `false` for large guilds (returns null) to avoid timeouts.',
    '',
    '**`include_roles`** WIDENS the prune (does not narrow it). An inactive member is pruned only if ALL of their roles appear in this list; a member holding ANY role not listed is never pruned. Members with no roles are always pruned regardless. Max 100.',
    '',
    '**Returns**: `{pruned, guild_id}` - `pruned` is null if `compute_prune_count` was false.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually prune.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to prune'),
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Inactivity threshold in days (1..30, default 7)'),
    compute_prune_count: z
      .boolean()
      .optional()
      .describe('Whether to return prune count (default true; set false for large guilds)'),
    include_roles: z
      .array(RoleId)
      .max(100)
      .optional()
      .describe(
        'WIDENS the prune (does not narrow it). An inactive member is pruned only if ALL of their roles appear in this list; a member holding ANY role not listed is never pruned. Members with no roles are always pruned regardless. Max 100.',
      ),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    pruned: z.number().int().nullable(),
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.days !== undefined) body.days = args.days;
    if (args.compute_prune_count !== undefined) body.compute_prune_count = args.compute_prune_count;
    if (args.include_roles !== undefined) body.include_roles = args.include_roles;
    const p = (await container.rest.post(Routes.guildPrune(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawPrune;
    return dualResult({
      text: `Pruned guild \`${args.guild_id}\`: ${p.pruned ?? 'count not computed'} member(s) kicked.`,
      data: { pruned: p.pruned, guild_id: args.guild_id },
    });
  },
});
