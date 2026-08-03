import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawMember {
  user: { id: string; username: string; global_name?: string | null };
  nick?: string | null;
  roles: string[];
  joined_at: string | null;
  premium_since?: string | null;
}

interface RawCurrentUser {
  id: string;
}

export default defineTool({
  name: 'members_get_current_user',
  category: 'members',
  description: [
    "**Purpose**: Fetch the current bot user's own member entry in a guild via `GET /users/@me` followed by `GET /guilds/{guild.id}/members/{bot.id}`.",
    '',
    '**When to use**:',
    "- Discover the bot's nick and role assignments in a target guild without needing the GUILD_MEMBERS intent.",
    '',
    '**Returns**: `{user_id, nick, roles, joined_at}`. Structured `nick` remains raw Discord data; the human-readable text response fences it.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to inspect'),
  },
  outputSchema: {
    user_id: UserId,
    nick: z.string().nullable(),
    roles: z.array(RoleId),
    joined_at: z.string().nullable(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const currentUser = (await container.rest.get(Routes.user('@me'))) as RawCurrentUser;
    const m = (await container.rest.get(
      Routes.guildMember(args.guild_id, currentUser.id),
    )) as RawMember;
    const wrappedNick =
      m.nick !== null && m.nick !== undefined ? wrapUntrusted(m.nick, 'username') : '_(no nick)_';
    return dualResult({
      text: `Bot member in guild \`${args.guild_id}\`: nick=${wrappedNick}, ${m.roles.length} role(s).`,
      data: {
        user_id: m.user.id,
        nick: m.nick ?? null,
        roles: m.roles,
        joined_at: m.joined_at,
      },
    });
  },
});
