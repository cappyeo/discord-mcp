import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, ScheduledEventId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawEvent {
  id: string;
  guild_id: string;
  name: string;
  description: string | null;
  scheduled_start_time: string;
  scheduled_end_time: string | null;
  status: number;
  entity_type: number;
  channel_id: string | null;
  // Omitted for events created before October 2021 (APIGuildScheduledEventBase).
  creator_id?: string | null;
  entity_metadata: { location?: string | null } | null;
  user_count?: number;
}

export default defineTool({
  name: 'events_get',
  category: 'events',
  description: [
    '**Purpose**: Fetch a single scheduled event by id.',
    '',
    '**When to use**:',
    '- Inspect a specific event before modifying or deleting.',
    '',
    '**Returns**: projected event shape with optional `user_count`. `creator_id` is absent for events created before October 2021. `name`/`description`/`entity_metadata.location` wrapped untrusted.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild that owns the event'),
    event_id: ScheduledEventId.describe('Scheduled event id'),
    with_user_count: z.boolean().optional().describe('Include `user_count` in response'),
  },
  outputSchema: {
    id: ScheduledEventId,
    guild_id: GuildId,
    scheduled_start_time: z.string(),
    scheduled_end_time: z.string().nullable(),
    status: z.number().int(),
    entity_type: z.number().int(),
    channel_id: ChannelId.nullable(),
    creator_id: UserId.nullable().optional(),
    user_count: z.number().int().optional(),
    untrusted_text: z.string(),
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
    if (args.with_user_count !== undefined)
      query.set('with_user_count', String(args.with_user_count));
    const ev = (await container.rest.get(
      Routes.guildScheduledEvent(args.guild_id, args.event_id),
      query.size > 0 ? { query } : undefined,
    )) as RawEvent;
    const wrapped = wrapUntrusted(
      JSON.stringify({
        name: ev.name,
        description: ev.description,
        location: ev.entity_metadata?.location ?? null,
      }),
      'channel_topic',
    );
    const data: Record<string, unknown> = {
      id: ev.id,
      guild_id: ev.guild_id,
      scheduled_start_time: ev.scheduled_start_time,
      scheduled_end_time: ev.scheduled_end_time,
      status: ev.status,
      entity_type: ev.entity_type,
      channel_id: ev.channel_id,
      untrusted_text: wrapped,
    };
    if (ev.creator_id !== undefined) data.creator_id = ev.creator_id;
    if (ev.user_count !== undefined) data.user_count = ev.user_count;
    return dualResult({
      text: `Event \`${ev.id}\` in guild \`${ev.guild_id}\` (status=${ev.status}). Name/description wrapped untrusted.`,
      data,
    });
  },
});
