import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import {
  SCHEDULED_EVENT_ENTITY_TYPE,
  SCHEDULED_EVENT_PRIVACY_LEVEL,
  SCHEDULED_EVENT_STATUS,
} from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, ScheduledEventId, UserId } from '../_lib/snowflake.js';
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
  entity_metadata: { location?: string | null } | null;
}

export default defineTool({
  name: 'events_modify',
  category: 'events',
  description: [
    '**Purpose**: Update fields of an existing scheduled event.',
    '',
    '**When to use**:',
    '- Reschedule, rename, change channel/location, or transition status (start/cancel/complete).',
    '',
    '**Status**: 1=SCHEDULED, 2=ACTIVE, 3=COMPLETED, 4=CANCELED. Status transitions are server-validated.',
    '',
    '**Returns**: projected event shape. `creator_id` is absent for events created before October 2021. `name`/`description`/`entity_metadata.location` wrapped untrusted.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild that owns the event'),
    event_id: ScheduledEventId.describe('Scheduled event id'),
    name: z.string().min(1).max(100).optional(),
    privacy_level: z.literal(SCHEDULED_EVENT_PRIVACY_LEVEL[0]).optional(),
    scheduled_start_time: z.string().optional(),
    scheduled_end_time: z.string().nullable().optional(),
    entity_type: z
      .union([
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[0]),
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[1]),
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[2]),
      ])
      .optional(),
    channel_id: ChannelId.nullable().optional(),
    entity_metadata: z.object({ location: z.string().min(1).max(100).optional() }).optional(),
    description: z.string().max(1000).nullable().optional(),
    image: z.string().nullable().optional(),
    recurrence_rule: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z
      .union([
        z.literal(SCHEDULED_EVENT_STATUS[0]),
        z.literal(SCHEDULED_EVENT_STATUS[1]),
        z.literal(SCHEDULED_EVENT_STATUS[2]),
        z.literal(SCHEDULED_EVENT_STATUS[3]),
      ])
      .optional()
      .describe('1=SCHEDULED, 2=ACTIVE, 3=COMPLETED, 4=CANCELED'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
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
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    const passthrough = [
      'name',
      'privacy_level',
      'scheduled_start_time',
      'scheduled_end_time',
      'entity_type',
      'channel_id',
      'entity_metadata',
      'description',
      'image',
      'recurrence_rule',
      'status',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const ev = (await container.rest.patch(
      Routes.guildScheduledEvent(args.guild_id, args.event_id),
      { body, reason: args.audit_reason },
    )) as RawEvent;
    const wrapped = wrapUntrusted(
      JSON.stringify({
        name: ev.name,
        description: ev.description ?? null,
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
    return dualResult({
      text: `Modified event \`${ev.id}\` (status=${ev.status}). Name/description wrapped untrusted.`,
      data,
    });
  },
});
