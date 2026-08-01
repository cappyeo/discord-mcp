import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, SoundboardSoundId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'soundboard_send_sound',
  category: 'soundboard',
  description: [
    '**Purpose**: Play a soundboard sound in a voice channel.',
    '',
    '**Pre-requisite**: the bot MUST be voice-connected to `channel_id`.',
    'Without `--gateway` enabled the bot cannot join voice - Discord will return an error.',
    '',
    '**Returns**: `{sent, channel_id, sound_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Voice channel where the bot is connected'),
    sound_id: SoundboardSoundId.describe('Sound to play'),
    source_guild_id: GuildId.optional().describe(
      "Origin guild ID if the sound isn't from the channel's guild",
    ),
  },
  outputSchema: {
    sent: z.literal(true),
    channel_id: ChannelId,
    sound_id: SoundboardSoundId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { sound_id: args.sound_id };
    if (args.source_guild_id !== undefined) body.source_guild_id = args.source_guild_id;
    await container.rest.post(Routes.sendSoundboardSound(args.channel_id), { body });
    return dualResult({
      text: `Sent soundboard sound \`${args.sound_id}\` to channel \`${args.channel_id}\`.`,
      data: { sent: true as const, channel_id: args.channel_id, sound_id: args.sound_id },
    });
  },
});
