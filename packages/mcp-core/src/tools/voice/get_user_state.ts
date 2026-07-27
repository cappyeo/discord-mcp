import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, UserId } from '../_lib/snowflake.js';

interface RawVoiceState {
  // Optional on APIVoiceState — Discord may omit it on guild-scoped lookups.
  guild_id?: string;
  channel_id: string | null;
  user_id: string;
  session_id: string;
  deaf: boolean;
  mute: boolean;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream?: boolean;
  self_video: boolean;
  suppress: boolean;
  request_to_speak_timestamp: string | null;
}

export default defineTool({
  name: 'voice_get_user_state',
  category: 'voice',
  description: [
    "**Purpose**: Fetch a user's voice state in a guild (`/guilds/{guild.id}/voice-states/{user.id}`).",
    '',
    '**Returns**: voice state shape (channel, mute/deaf flags, request_to_speak_timestamp).',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
    user_id: UserId.describe('Member whose voice state to fetch'),
  },
  outputSchema: {
    guild_id: GuildId,
    channel_id: ChannelId.nullable(),
    user_id: UserId,
    session_id: z.string(),
    deaf: z.boolean(),
    mute: z.boolean(),
    self_deaf: z.boolean(),
    self_mute: z.boolean(),
    self_stream: z.boolean().optional(),
    self_video: z.boolean(),
    suppress: z.boolean(),
    request_to_speak_timestamp: z.string().nullable(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const r = (await container.rest.get(
      Routes.guildVoiceState(args.guild_id, args.user_id),
    )) as RawVoiceState;
    return dualResult({
      text: `Voice state for user \`${r.user_id}\` in guild \`${args.guild_id}\` (channel ${
        r.channel_id ?? 'none'
      }).`,
      data: {
        guild_id: r.guild_id ?? args.guild_id,
        channel_id: r.channel_id,
        user_id: r.user_id,
        session_id: r.session_id,
        deaf: r.deaf,
        mute: r.mute,
        self_deaf: r.self_deaf,
        self_mute: r.self_mute,
        self_stream: r.self_stream,
        self_video: r.self_video,
        suppress: r.suppress,
        request_to_speak_timestamp: r.request_to_speak_timestamp,
      },
    });
  },
});
