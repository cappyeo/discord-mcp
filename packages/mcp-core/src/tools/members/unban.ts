import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'members_unban',
  category: 'members',
  description: [
    '**Purpose**: Remove a ban for a user (allowing them to rejoin).',
    '',
    '**When to use**:',
    '- Restore a previously-banned user.',
    '',
    '**Returns**: `{unbanned, user_id, guild_id}`. Idempotent - unbanning a non-banned user returns 404 from Discord.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to unban from'),
    user_id: UserId.describe('Banned user to release'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    unbanned: z.literal(true),
    user_id: UserId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildBan(args.guild_id, args.user_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Unbanned user \`${args.user_id}\` from guild \`${args.guild_id}\`.`,
      data: { unbanned: true as const, user_id: args.user_id, guild_id: args.guild_id },
    });
  },
});
