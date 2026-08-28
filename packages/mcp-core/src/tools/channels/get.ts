import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { CHANNEL_READ_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawChannelDetail {
  id: string;
  // `null` for DM channels, absent on partials - never assume a string.
  name?: string | null;
  type: number;
  // Only sortable guild channels carry `position`/`parent_id`; threads and DMs omit them.
  position?: number;
  parent_id?: string | null;
  nsfw?: boolean;
  topic?: string | null;
  rate_limit_per_user?: number;
  guild_id?: string;
}

export default defineTool({
  name: 'channels_get',
  category: 'channels',
  access: CHANNEL_READ_ACCESS,
  description:
    '**Purpose**: Fetch full metadata for a single Discord channel.\n\n**When to use**: inspect topic, slowmode, nsfw of a known channel.\n\n**Returns**: `{id, name, type, nsfw, topic, rate_limit_per_user, position?, parent_id?, guild_id?}`. `name` is `null` for DMs. `position` and `parent_id` are guild-channel-only - both are absent for threads and DMs. Structured `topic` remains raw user-controlled data; the human-readable text response fences it.',
  inputSchema: {
    channel_id: ChannelId.describe('Target channel ID'),
  },
  outputSchema: {
    id: ChannelId,
    name: z.string().nullable(),
    type: z.number().int(),
    position: z.number().int().optional(),
    parent_id: ChannelId.nullable().optional(),
    nsfw: z.boolean(),
    topic: z.string().nullable(),
    rate_limit_per_user: z.number().int(),
    guild_id: GuildId.optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const c = (await container.rest.get(Routes.channel(args.channel_id))) as RawChannelDetail;
    const topicWrapped =
      c.topic !== null && c.topic !== undefined
        ? wrapUntrusted(c.topic, 'channel_topic')
        : '_(no topic)_';
    const data: Record<string, unknown> = {
      id: c.id,
      name: c.name ?? null,
      type: c.type,
      nsfw: c.nsfw ?? false,
      topic: c.topic ?? null,
      rate_limit_per_user: c.rate_limit_per_user ?? 0,
    };
    if (c.position !== undefined) data.position = c.position;
    if (c.parent_id !== undefined) data.parent_id = c.parent_id;
    if (c.guild_id !== undefined) data.guild_id = c.guild_id;
    const label =
      c.name !== null && c.name !== undefined ? `**#${c.name}**` : '_(unnamed channel)_';
    return dualResult({
      text: `${label} (\`channel:${c.id}\`, type ${c.type})\nTopic: ${topicWrapped}\nSlowmode: ${data.rate_limit_per_user}s`,
      data,
    });
  },
});
