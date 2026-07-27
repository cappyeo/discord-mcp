import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { UserId } from '../_lib/snowflake.js';

interface RawUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  // Optional on APIUser — absent means "not a bot".
  bot?: boolean;
  verified?: boolean;
}

export default defineTool({
  name: 'users_get_current',
  category: 'users',
  description:
    '**Purpose**: Fetch the authenticated bot/user profile (`/users/@me`).\n\n**When to use**: confirm bot identity; get bot ID for `commands_list_guild` etc.\n\n**Returns**: `{id, username, global_name, avatar, bot, verified}`.',
  inputSchema: {},
  outputSchema: {
    id: UserId,
    username: z.string(),
    global_name: z.string().nullable(),
    avatar: z.string().nullable(),
    bot: z.boolean(),
    verified: z.boolean().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async () => {
    const u = (await container.rest.get(Routes.user('@me'))) as RawUser;
    const data: Record<string, unknown> = {
      id: u.id,
      username: u.username,
      global_name: u.global_name,
      avatar: u.avatar,
      bot: u.bot ?? false,
    };
    if (u.verified !== undefined) data.verified = u.verified;
    return dualResult({
      text: `**${u.username}** (\`user:${u.id}\`, ${u.bot ? 'bot' : 'user'})`,
      data,
    });
  },
});
