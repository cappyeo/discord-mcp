import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'members_kick',
  category: 'members',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Kick (remove) a member from a guild. **DESTRUCTIVE - they lose roles and must rejoin.**',
    '',
    '**When to use**:',
    '- Force-disconnect a member without banning them.',
    '',
    '**When NOT to use**:',
    '- Permanent ban → use `members_ban`.',
    '',
    '**Returns**: `{kicked, user_id, guild_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually kick.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to kick from'),
    user_id: UserId.describe('Member to kick'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    kicked: z.literal(true),
    user_id: UserId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildMember(args.guild_id, args.user_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Kicked user \`${args.user_id}\` from guild \`${args.guild_id}\`.`,
      data: { kicked: true as const, user_id: args.user_id, guild_id: args.guild_id },
    });
  },
});
