import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawEvent {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time: string | null;
  status: number;
  entity_type: number;
  channel_id: string | null;
  // Omitted for events created before October 2021 (APIGuildScheduledEventBase).
  creator_id?: string | null;
}

export default defineTool({
  name: 'events_list',
  category: 'events',
  description:
    '**Purpose**: List scheduled events for a guild.\n\n**When to use**: enumerate upcoming voice/stage/external events.\n\n**Returns**: `{events:[...], count}`. Structured names and descriptions remain raw Discord data; the human-readable text response fences event names.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
  },
  outputSchema: {
    events: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
        scheduled_start_time: z.string(),
        scheduled_end_time: z.string().nullable(),
        status: z.number().int(),
        entity_type: z.number().int(),
        channel_id: ChannelId.nullable(),
        creator_id: UserId.nullable().optional(),
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
    const raw = (await container.rest.get(
      Routes.guildScheduledEvents(args.guild_id),
    )) as RawEvent[];
    const evs = raw.map((e) => ({
      id: e.id,
      name: e.name,
      scheduled_start_time: e.scheduled_start_time,
      scheduled_end_time: e.scheduled_end_time,
      status: e.status,
      entity_type: e.entity_type,
      channel_id: e.channel_id,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.creator_id !== undefined ? { creator_id: e.creator_id } : {}),
    }));
    const lines = evs.map(
      (e) => `- ${wrapUntrusted(e.name, 'username')} starts ${e.scheduled_start_time}`,
    );
    return dualResult({
      text: `**${evs.length} scheduled event(s)**:\n${lines.join('\n')}`,
      data: { events: evs, count: evs.length },
    });
  },
});
