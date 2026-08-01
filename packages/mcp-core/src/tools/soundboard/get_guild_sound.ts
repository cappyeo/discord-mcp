import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, SoundboardSoundId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawSound {
  sound_id: string;
  name: string;
  volume: number;
  emoji_id: string | null;
  emoji_name: string | null;
  // Optional on APISoundboardSound.
  guild_id?: string;
  available: boolean;
}

export default defineTool({
  name: 'soundboard_get_guild_sound',
  category: 'soundboard',
  description: [
    '**Purpose**: Fetch a single guild soundboard sound.',
    '',
    '**Returns**: `{sound_id, name, volume, emoji_id, emoji_name, guild_id, available, untrusted_text}`. `name` remains raw Discord data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the sound'),
    sound_id: SoundboardSoundId.describe('Soundboard sound ID'),
  },
  outputSchema: {
    sound_id: SoundboardSoundId,
    name: z.string(),
    volume: z.number(),
    emoji_id: z.string().nullable(),
    emoji_name: z.string().nullable(),
    guild_id: GuildId,
    available: z.boolean(),
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
    const s = (await container.rest.get(
      Routes.guildSoundboardSound(args.guild_id, args.sound_id),
    )) as RawSound;
    const wrapped = wrapUntrusted(JSON.stringify({ name: s.name }), 'username');
    return dualResult({
      text: `Soundboard sound \`${s.sound_id}\` (name wrapped untrusted).`,
      data: {
        sound_id: s.sound_id,
        name: s.name,
        volume: s.volume,
        emoji_id: s.emoji_id,
        emoji_name: s.emoji_name,
        guild_id: s.guild_id ?? args.guild_id,
        available: s.available,
        untrusted_text: wrapped,
      },
    });
  },
});
