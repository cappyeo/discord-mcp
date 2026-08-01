import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawThread {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  owner_id?: string;
  thread_metadata?: { archived?: boolean; locked?: boolean };
}

interface RawActiveThreads {
  threads: RawThread[];
  members?: unknown[];
}

export default defineTool({
  name: 'channels_list_active_threads_guild',
  category: 'channels',
  description: [
    '**Purpose**: List every active thread the bot can see across an entire guild.',
    '',
    '**When to use**:',
    '- Discover hot threads for moderation; sweep stale threads.',
    '',
    '**When NOT to use**:',
    '- Single-channel archived threads → use `channels_list_public_archived_threads` / `_private_archived_threads`.',
    '',
    '**Returns**: `{threads:[{id, name, type, parent_id, owner_id, archived, locked}], count, guild_id}`. Structured thread names remain raw Discord data; the human-readable text response fences them.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to list active threads for'),
  },
  outputSchema: {
    threads: z.array(
      z.object({
        id: ChannelId,
        name: z.string(),
        type: z.number().int(),
        parent_id: ChannelId.nullable(),
        owner_id: UserId.nullable(),
        archived: z.boolean(),
        locked: z.boolean(),
      }),
    ),
    count: z.number().int(),
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(
      Routes.guildActiveThreads(args.guild_id),
    )) as RawActiveThreads;
    const threads = raw.threads.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      parent_id: t.parent_id ?? null,
      owner_id: t.owner_id ?? null,
      archived: t.thread_metadata?.archived ?? false,
      locked: t.thread_metadata?.locked ?? false,
    }));
    const namesWrapped = wrapUntrusted(
      threads.map((t) => `[${t.id}] ${t.name}`).join('\n'),
      'message',
    );
    return dualResult({
      text: `**${threads.length} active thread(s)** in guild \`${args.guild_id}\`:\n${namesWrapped}`,
      data: { threads, count: threads.length, guild_id: args.guild_id },
    });
  },
});
