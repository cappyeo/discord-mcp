import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

interface RawBan {
  user: { id: string; username: string; global_name?: string | null };
  reason: string | null;
}

export default defineTool({
  name: 'members_get_ban',
  category: 'members',
  description: [
    '**Purpose**: Look up a single ban entry by user ID.',
    '',
    '**When to use**:',
    '- Confirm whether a user is currently banned and why.',
    '',
    '**Returns**: `{user_id, username, reason}`. Discord returns 404 if not banned.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to inspect'),
    user_id: UserId.describe('User to look up'),
  },
  outputSchema: {
    user_id: UserId,
    username: z.string(),
    reason: z.string().nullable(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const b = (await container.rest.get(Routes.guildBan(args.guild_id, args.user_id))) as RawBan;
    return dualResult({
      text: `Ban: \`${b.user.username}\` (\`user:${b.user.id}\`) - reason: ${b.reason ?? '_(none)_'}`,
      data: { user_id: b.user.id, username: b.user.username, reason: b.reason },
    });
  },
});
