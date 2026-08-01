import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features: string[];
  approximate_member_count?: number;
  approximate_presence_count?: number;
}

export default defineTool({
  name: 'users_list_current_user_guilds',
  category: 'users',
  description: [
    '**Purpose**: List guilds the bot/user is a member of (`/users/@me/guilds`).',
    '',
    '**When to use**:',
    '- Discover all guilds the bot has joined.',
    '',
    '**Pagination**: `before`/`after` are guild-id cursors. `limit` 1-200.',
    '',
    '**Returns**: `{guilds:[{id, name, owner, permissions, features}], count, untrusted_names}`. Guild names remain raw Discord data; `untrusted_names` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    before: GuildId.optional().describe('Pagination cursor: guilds with id < this'),
    after: GuildId.optional().describe('Pagination cursor: guilds with id > this'),
    limit: z.number().int().min(1).max(200).optional().describe('Max guilds (1-200, default 200)'),
    with_counts: z.boolean().optional().describe('Include approximate member/presence counts'),
  },
  outputSchema: {
    guilds: z.array(
      z.object({
        id: GuildId,
        owner: z.boolean(),
        permissions: z.string(),
        features: z.array(z.string()),
        approximate_member_count: z.number().int().optional(),
      }),
    ),
    count: z.number().int(),
    untrusted_names: z.string(),
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
    if (args.before !== undefined) query.set('before', args.before);
    if (args.after !== undefined) query.set('after', args.after);
    if (args.limit !== undefined) query.set('limit', String(args.limit));
    if (args.with_counts !== undefined) query.set('with_counts', String(args.with_counts));
    const raw = (await container.rest.get(
      Routes.userGuilds(),
      query.size > 0 ? { query } : undefined,
    )) as RawGuildSummary[];
    const guilds = raw.map((g) => {
      const out: {
        id: string;
        owner: boolean;
        permissions: string;
        features: string[];
        approximate_member_count?: number;
      } = {
        id: g.id,
        owner: g.owner,
        permissions: g.permissions,
        features: g.features,
      };
      if (g.approximate_member_count !== undefined)
        out.approximate_member_count = g.approximate_member_count;
      return out;
    });
    const wrapped = wrapUntrusted(
      JSON.stringify(raw.map((g) => ({ id: g.id, name: g.name }))),
      'channel_topic',
    );
    return dualResult({
      text: `Bot is in **${guilds.length} guild(s)**. Names wrapped untrusted.`,
      data: { guilds, count: guilds.length, untrusted_names: wrapped },
    });
  },
});
