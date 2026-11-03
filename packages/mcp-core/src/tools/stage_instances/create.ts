import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { withAttributionField } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, ScheduledEventId, StageInstanceId } from '../_lib/snowflake.js';

interface RawStageInstance {
  id: string;
  guild_id: string;
  channel_id: string;
  topic: string;
  privacy_level: number;
}

export default defineTool({
  name: 'stage_instances_create',
  category: 'stage_instances',
  description: [
    '**Purpose**: Start a Stage instance (live event in a Stage channel).',
    '',
    '**When to use**:',
    '- Begin a public talk/AMA in a stage channel.',
    '',
    '**Returns**: `{id, guild_id, channel_id, topic, privacy_level}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Stage channel to host the instance'),
    topic: z.string().min(1).max(120).describe('Topic of the stage (1..120 chars)'),
    privacy_level: z
      .number()
      .int()
      .optional()
      .describe('1 PUBLIC (deprecated), 2 GUILD_ONLY (default)'),
    send_start_notification: z
      .boolean()
      .optional()
      .describe('Notify @everyone that a stage has started'),
    guild_scheduled_event_id: ScheduledEventId.optional().describe(
      'Associate with an existing scheduled event',
    ),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: StageInstanceId,
    guild_id: z.string(),
    channel_id: ChannelId,
    topic: z.string(),
    privacy_level: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {
      channel_id: args.channel_id,
      topic: withAttributionField(args.topic, ctx.caller, 'Created', 120) ?? args.topic,
    };
    if (args.privacy_level !== undefined) body.privacy_level = args.privacy_level;
    if (args.send_start_notification !== undefined)
      body.send_start_notification = args.send_start_notification;
    if (args.guild_scheduled_event_id !== undefined)
      body.guild_scheduled_event_id = args.guild_scheduled_event_id;
    const r = (await container.rest.post(Routes.stageInstances(), {
      body,
      reason: args.audit_reason,
    })) as RawStageInstance;
    return dualResult({
      text: `Stage instance \`${r.id}\` started in channel \`${r.channel_id}\`.`,
      data: {
        id: r.id,
        guild_id: r.guild_id,
        channel_id: r.channel_id,
        topic: r.topic,
        privacy_level: r.privacy_level,
      },
    });
  },
});
