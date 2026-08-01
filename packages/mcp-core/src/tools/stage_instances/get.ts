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
  name: 'stage_instances_get',
  category: 'stage_instances',
  description: [
    '**Purpose**: Fetch the live Stage instance for a channel.',
    '',
    '**Returns**: `{id, guild_id, channel_id, topic, privacy_level, untrusted_text}`.',
    'The `topic` remains raw user-authored data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Stage channel'),
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
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const r = (await container.rest.get(Routes.stageInstance(args.channel_id))) as RawStageInstance;
    const wrapped = wrapUntrusted(JSON.stringify({ topic: r.topic }), 'channel_topic');
    return dualResult({
      text: `Stage instance \`${r.id}\` (channel \`${r.channel_id}\`, topic wrapped untrusted).`,
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
