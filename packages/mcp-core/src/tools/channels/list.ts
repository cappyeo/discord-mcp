import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

interface RawChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  // Optional on APIGuildChannel — absent (not null) for top-level channels.
  parent_id?: string | null;
  nsfw?: boolean;
}

export default defineTool({
  name: 'channels_list',
  category: 'channels',
  description:
    '**Purpose**: List all channels in a Discord guild.\n\n**When to use**: discover channel IDs by name; audit channel layout.\n\n**Example**: `{guild_id:"999000999000999000"}`\n\n**Returns**: `{channels:[{id,name,type,position,parent_id,nsfw}], count}`.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to list channels for'),
  },
  outputSchema: {
    channels: z.array(
      z.object({
        id: ChannelId,
        name: z.string(),
        type: z.number().int(),
        position: z.number().int(),
        parent_id: ChannelId.nullable(),
        nsfw: z.boolean(),
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
    const raw = (await container.rest.get(Routes.guildChannels(args.guild_id))) as RawChannel[];
    const channels = raw.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      position: c.position,
      parent_id: c.parent_id ?? null,
      nsfw: c.nsfw ?? false,
    }));
    return dualResult({
      text:
        `Found ${channels.length} channel(s):\n` +
        channels.map((c) => `- #${c.name} (\`channel:${c.id}\`, type ${c.type})`).join('\n'),
      data: { channels, count: channels.length },
    });
  },
});
