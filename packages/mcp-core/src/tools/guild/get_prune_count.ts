import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId } from '../_lib/snowflake.js';

interface RawPrune {
  pruned: number;
}

export default defineTool({
  name: 'guild_get_prune_count',
  category: 'guild',
  description: [
    '**Purpose**: Preview how many members would be pruned (kicked) for inactivity.',
    '',
    '**When to use**:',
    '- Estimate impact before calling `guild_begin_prune`.',
    '',
    '**`days`** (1..30) is the inactivity threshold.',
    '',
    '**`include_roles`** WIDENS the prune (does not narrow it). An inactive member is pruned only if ALL of their roles appear in this list; a member holding ANY role not listed is never pruned. Members with no roles are always pruned regardless. Max 100.',
    '',
    '**Returns**: `{pruned}` (estimated kick count).',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Inactivity threshold in days (1..30, default 7)'),
    include_roles: z
      .array(RoleId)
      .max(100)
      .optional()
      .describe(
        'WIDENS the prune (does not narrow it). An inactive member is pruned only if ALL of their roles appear in this list; a member holding ANY role not listed is never pruned. Members with no roles are always pruned regardless. Max 100.',
      ),
  },
  outputSchema: {
    pruned: z.number().int(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const query = new URLSearchParams();
    if (args.days !== undefined) query.set('days', String(args.days));
    if (args.include_roles !== undefined && args.include_roles.length > 0) {
      query.set('include_roles', args.include_roles.join(','));
    }
    const p = (await container.rest.get(Routes.guildPrune(args.guild_id), {
      query,
    })) as RawPrune;
    return dualResult({
      text: `Prune preview for \`${args.guild_id}\`: ${p.pruned} member(s) would be kicked.`,
      data: { pruned: p.pruned },
    });
  },
});
