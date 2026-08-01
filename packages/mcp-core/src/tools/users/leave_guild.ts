import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'users_leave_guild',
  category: 'users',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Make the authenticated bot/user leave a guild. **DESTRUCTIVE - bot loses access immediately.**',
    '',
    '**When to use**:',
    '- Decommission the bot from a guild it should no longer be in.',
    '',
    '**Note**: User-scoped endpoint - does NOT accept `audit_reason`.',
    '',
    '**Returns**: `{left, guild_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually leave.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to leave'),
  },
  outputSchema: {
    left: z.literal(true),
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.userGuild(args.guild_id));
    return dualResult({
      text: `Left guild \`${args.guild_id}\`.`,
      data: { left: true as const, guild_id: args.guild_id },
    });
  },
});
