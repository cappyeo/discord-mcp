import { container } from '@sapphire/pieces';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

interface SearchMember {
  member: {
    user: { id: string; username: string; global_name?: string | null };
    nick?: string | null;
  };
}

interface SearchResponse {
  members: SearchMember[];
}

export default defineTool({
  name: 'members_search',
  category: 'members',
  description:
    '**Purpose**: Fuzzy-search guild members by username/nick prefix.\n\n**When to use**: convert "find @alice" or "users named bob" into snowflake IDs.\n\n**Example**: `{guild_id:"999000999000999000", query:"alice", limit:25}`\n\n**Returns**: `{matches:[{user_id, username, global_name, nick}], count}`.\n\n**Rate limit**: 5/sec/guild.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to search'),
    query: z.string().min(1).max(100).describe('Username/nick prefix or substring'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(25)
      .describe('Max matches (1-1000, default 25)'),
  },
  outputSchema: {
    matches: z.array(
      z.object({
        user_id: UserId,
        username: z.string(),
        global_name: z.string().nullable(),
        nick: z.string().nullable(),
      }),
    ),
    count: z.number(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body = {
      limit: args.limit,
      and_query: { username: { or_query: [args.query] } },
    };
    const resp = (await container.rest.post(
      `/guilds/${args.guild_id}/members-search` as `/${string}`,
      { body },
    )) as SearchResponse;
    const matches = resp.members.map((m) => ({
      user_id: m.member.user.id,
      username: m.member.user.username,
      global_name: m.member.user.global_name ?? null,
      nick: m.member.nick ?? null,
    }));
    return dualResult({
      text:
        `Found ${matches.length} member(s) matching \`${args.query}\`:\n` +
        matches.map((m) => `- ${m.username} (\`user:${m.user_id}\`)`).join('\n'),
      data: { matches, count: matches.length },
    });
  },
});
