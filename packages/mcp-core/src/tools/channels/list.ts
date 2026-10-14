import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { ChannelTagOutput, type ChannelTags, channelTags } from '../_lib/forum-tags.js';
import {
  PermissionOverwrite,
  type PermissionOverwrite as PermissionOverwriteValue,
} from '../_lib/permissions.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

interface RawChannel extends ChannelTags {
  id: string;
  name: string;
  type: number;
  position: number;
  // Optional on APIGuildChannel - absent (not null) for top-level channels.
  parent_id?: string | null;
  nsfw?: boolean;
  permission_overwrites?: PermissionOverwriteValue[];
}

export default defineTool({
  name: 'channels_list',
  category: 'channels',
  description:
    '**Purpose**: List all channels in a Discord guild.\n\n**When to use**: discover channel IDs by name; audit channel layout, permission overwrites, and forum tags.\n\n**Example**: `{guild_id:"999000999000999000"}`\n\n**Returns**: `{channels:[{id,name,type,position,parent_id,nsfw,permission_overwrites?,available_tags?,applied_tags?}], count}`. Permission overwrites preserve Discord role/member targets and string `allow`/`deny` bitfields. Missing fields stay absent; empty arrays stay empty. Forum/media tags include `{id,name,moderated,emoji_id,emoji_name}` when returned by Discord.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to list channels for'),
  },
  outputSchema: {
    channels: z.array(
      z.object({
        ...ChannelTagOutput,
        id: ChannelId,
        name: z.string(),
        type: z.number().int(),
        position: z.number().int(),
        parent_id: ChannelId.nullable(),
        nsfw: z.boolean(),
        permission_overwrites: PermissionOverwrite.array().optional(),
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
      ...channelTags(c),
      id: c.id,
      name: c.name,
      type: c.type,
      position: c.position,
      parent_id: c.parent_id ?? null,
      nsfw: c.nsfw ?? false,
      ...(c.permission_overwrites === undefined
        ? {}
        : { permission_overwrites: c.permission_overwrites }),
    }));
    return dualResult({
      text:
        `Found ${channels.length} channel(s):\n` +
        channels.map((c) => `- #${c.name} (\`channel:${c.id}\`, type ${c.type})`).join('\n'),
      data: { channels, count: channels.length },
    });
  },
});
