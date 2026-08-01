import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, StageInstanceId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawStageInstance {
  id: string;
  guild_id: string;
  channel_id: string;
  topic: string;
  privacy_level: number;
}

export default defineTool({
  name: 'stage_instances_modify',
  category: 'stage_instances',
  description: [
    '**Purpose**: Modify the live Stage instance (topic / privacy_level).',
    '',
    '**Pass only fields you want to change.**',
    '',
    '**Returns**: updated `{id, guild_id, channel_id, topic, privacy_level, untrusted_text}`. `topic` remains raw user-authored data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Stage channel'),
    topic: z.string().min(1).max(120).optional(),
    privacy_level: z.number().int().optional(),
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
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.topic !== undefined) body.topic = args.topic;
    if (args.privacy_level !== undefined) body.privacy_level = args.privacy_level;
    const r = (await container.rest.patch(Routes.stageInstance(args.channel_id), {
      body,
      reason: args.audit_reason,
    })) as RawStageInstance;
    const wrapped = wrapUntrusted(JSON.stringify({ topic: r.topic }), 'channel_topic');
    return dualResult({
      text: `Modified stage instance \`${r.id}\` (topic wrapped untrusted).`,
      data: {
        id: r.id,
        guild_id: r.guild_id,
        channel_id: r.channel_id,
        topic: r.topic,
        privacy_level: r.privacy_level,
        untrusted_text: wrapped,
      },
    });
  },
});
