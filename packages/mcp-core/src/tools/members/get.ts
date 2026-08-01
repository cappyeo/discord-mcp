import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawMember {
  user: {
    id: string;
    username: string;
    global_name?: string | null;
    avatar: string | null;
    bot?: boolean;
  };
  nick?: string | null;
  roles: string[];
  // Nullable per APIGuildMemberJoined; the boost/screening fields are optional
  // (APIBaseGuildMember) and Discord omits them for members it has no data for.
  joined_at: string | null;
  premium_since?: string | null;
  pending?: boolean;
}

export default defineTool({
  name: 'members_get',
  category: 'members',
  description:
    '**Purpose**: Fetch a guild member by user ID.\n\n**When to use**: inspect roles, nick, joined-at of a known user.\n\n**Returns**: `{user_id, username, global_name, nick, roles, joined_at, premium_since?, pending?}`. `joined_at` may be `null`; `premium_since` and `pending` are absent when Discord omits them. Structured `nick` remains raw Discord data; the human-readable text response fences it.',
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the member'),
    user_id: UserId.describe('Member to fetch'),
  },
  outputSchema: {
    user_id: UserId,
    username: z.string(),
    global_name: z.string().nullable(),
    nick: z.string().nullable(),
    roles: z.array(RoleId),
    joined_at: z.string().nullable(),
    premium_since: z.string().nullable().optional(),
    pending: z.boolean().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const m = (await container.rest.get(
      Routes.guildMember(args.guild_id, args.user_id),
    )) as RawMember;
    const wrappedNick =
      m.nick !== null && m.nick !== undefined ? wrapUntrusted(m.nick, 'username') : '_(no nick)_';
    const data: Record<string, unknown> = {
      user_id: m.user.id,
      username: m.user.username,
      global_name: m.user.global_name ?? null,
      nick: m.nick ?? null,
      roles: m.roles,
      joined_at: m.joined_at,
    };
    if (m.premium_since !== undefined) data.premium_since = m.premium_since;
    if (m.pending !== undefined) data.pending = m.pending;
    return dualResult({
      text: `**${m.user.username}** (\`user:${m.user.id}\`)\nNick: ${wrappedNick}\nRoles: ${m.roles.length}\nJoined: ${m.joined_at ?? '_(unknown)_'}`,
      data,
    });
  },
});
