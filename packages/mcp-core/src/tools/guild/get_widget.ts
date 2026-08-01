import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';

interface RawWidget {
  id: string;
  name: string;
  instant_invite: string | null;
  channels: Array<{ id: string; name: string; position: number }>;
  members: Array<{ id: string; username: string; status: string; avatar_url?: string }>;
  presence_count: number;
}

export default defineTool({
  name: 'guild_get_widget',
  category: 'guild',
  description: [
    '**Purpose**: Get the public guild widget JSON. **No bot auth required** - Discord serves this anonymously.',
    '',
    '**When to use**:',
    '- Render a public-facing widget on a website. The widget must be enabled (see `guild_get_widget_settings`).',
    '',
    '**Returns**: `{id, name, instant_invite, channels, members, presence_count}` (raw passthrough).',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
  },
  outputSchema: {
    id: GuildId,
    name: z.string(),
    instant_invite: z.string().nullable(),
    presence_count: z.number().int(),
    channels: z.array(z.object({ id: z.string(), name: z.string(), position: z.number().int() })),
    members_count: z.number().int(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const w = (await container.rest.get(Routes.guildWidgetJSON(args.guild_id), {
      auth: false,
    })) as RawWidget;
    return dualResult({
      text: `Widget for \`${w.id}\` (${w.name}): ${w.presence_count} online, ${w.channels.length} channels.`,
      data: {
        id: w.id,
        name: w.name,
        instant_invite: w.instant_invite,
        presence_count: w.presence_count,
        channels: w.channels.map((c) => ({ id: c.id, name: c.name, position: c.position })),
        members_count: w.members.length,
      },
    });
  },
});
