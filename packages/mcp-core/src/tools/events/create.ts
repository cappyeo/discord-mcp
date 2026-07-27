import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import {
  SCHEDULED_EVENT_ENTITY_TYPE,
  SCHEDULED_EVENT_PRIVACY_LEVEL,
} from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, ScheduledEventId, UserId } from '../_lib/snowflake.js';

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
  name: 'events_create',
  category: 'events',
  description: [
    '**Purpose**: Create a new scheduled event for a guild.',
    '',
    '**When to use**:',
    '- Schedule a stage, voice, or external event in a guild.',
    '',
    '**Entity types**: 1=STAGE_INSTANCE, 2=VOICE, 3=EXTERNAL. STAGE/VOICE require `channel_id`. EXTERNAL requires `entity_metadata.location` and `scheduled_end_time`.',
    '',
    '**Returns**: `{id, name, scheduled_start_time, status, entity_type, channel_id, description?, creator_id?}`. `creator_id` is absent for events created before October 2021.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to create the event in'),
    name: z.string().min(1).max(100).describe('Event name (1-100 chars)'),
    privacy_level: z
      .literal(SCHEDULED_EVENT_PRIVACY_LEVEL[0])
      .default(SCHEDULED_EVENT_PRIVACY_LEVEL[0])
      .describe('Always 2 (GUILD_ONLY)'),
    scheduled_start_time: z.string().describe('ISO 8601 timestamp when the event starts'),
    entity_type: z
      .union([
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[0]),
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[1]),
        z.literal(SCHEDULED_EVENT_ENTITY_TYPE[2]),
      ])
      .describe('1=STAGE_INSTANCE, 2=VOICE, 3=EXTERNAL'),
    channel_id: ChannelId.optional().describe(
      'Required for STAGE/VOICE; must be a stage or voice channel',
    ),
    entity_metadata: z
      .object({ location: z.string().min(1).max(100).optional() })
      .optional()
      .describe('Required for EXTERNAL events; `location` is the venue text'),
    scheduled_end_time: z
      .string()
      .optional()
      .describe('ISO 8601 end timestamp (required for EXTERNAL)'),
    description: z.string().max(1000).optional().describe('Event description (max 1000 chars)'),
    image: z.string().nullable().optional().describe('Cover image as base64 data URI, or null'),
    recurrence_rule: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Recurrence rule object (see Discord docs)'),
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
    name: z.string(),
    description: z.string().nullable().optional(),
    scheduled_start_time: z.string(),
    scheduled_end_time: z.string().nullable(),
    status: z.number().int(),
    entity_type: z.number().int(),
    channel_id: ChannelId.nullable(),
    creator_id: UserId.nullable().optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {
      name: args.name,
      privacy_level: args.privacy_level ?? SCHEDULED_EVENT_PRIVACY_LEVEL[0],
      scheduled_start_time: args.scheduled_start_time,
      entity_type: args.entity_type,
    };
    if (args.channel_id !== undefined) body.channel_id = args.channel_id;
    if (args.entity_metadata !== undefined) body.entity_metadata = args.entity_metadata;
    if (args.scheduled_end_time !== undefined) body.scheduled_end_time = args.scheduled_end_time;
    if (args.description !== undefined) body.description = args.description;
    if (args.image !== undefined) body.image = args.image;
    if (args.recurrence_rule !== undefined) body.recurrence_rule = args.recurrence_rule;
    const ev = (await container.rest.post(Routes.guildScheduledEvents(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawEvent;
    const data: Record<string, unknown> = {
      id: ev.id,
      guild_id: ev.guild_id,
      name: ev.name,
      scheduled_start_time: ev.scheduled_start_time,
      scheduled_end_time: ev.scheduled_end_time,
      status: ev.status,
      entity_type: ev.entity_type,
      channel_id: ev.channel_id,
    };
    if (ev.description !== undefined) data.description = ev.description;
    if (ev.creator_id !== undefined) data.creator_id = ev.creator_id;
    return dualResult({
      text: `Created scheduled event \`${ev.id}\` in guild \`${ev.guild_id}\` (starts ${ev.scheduled_start_time}).`,
      data,
    });
  },
});
