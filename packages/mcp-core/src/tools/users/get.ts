import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  bot?: boolean;
  banner?: string | null;
  accent_color?: number | null;
}

export default defineTool({
  name: 'users_get',
  category: 'users',
  description: [
    '**Purpose**: Look up a public user profile by id (`/users/{user.id}`).',
    '',
    '**When to use**:',
    '- Resolve a username/avatar for a user id surfaced by another tool.',
    '',
    '**When NOT to use**:',
    '- Fetching guild-specific member info → `members_get`. Bot identity → `users_get_current`.',
    '',
    '**Returns**: `{id, username, global_name, avatar, bot, untrusted_text}`. Names remain raw Discord data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    user_id: UserId.describe('Discord user id'),
  },
  outputSchema: {
    id: UserId,
    username: z.string(),
    global_name: z.string().nullable(),
    avatar: z.string().nullable(),
    bot: z.boolean(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const u = (await container.rest.get(Routes.user(args.user_id))) as RawUser;
    const wrapped = wrapUntrusted(
      JSON.stringify({ username: u.username, global_name: u.global_name }),
      'username',
    );
    return dualResult({
      text: `User \`${u.id}\` (${u.bot ? 'bot' : 'user'}). Names wrapped untrusted.`,
      data: {
        id: u.id,
        username: u.username,
        global_name: u.global_name,
        avatar: u.avatar,
        bot: u.bot ?? false,
        untrusted_text: wrapped,
      },
    });
  },
});
