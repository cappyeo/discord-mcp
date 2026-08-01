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
  guild_id: string;
  available: boolean;
}

interface RawListResponse {
  items: RawSound[];
}

export default defineTool({
  name: 'soundboard_list_guild_sounds',
  category: 'soundboard',
  description: [
    "**Purpose**: List a guild's custom soundboard sounds.",
    '',
    '**Returns**: `{sounds:[...], count, untrusted_names}`. Names remain raw Discord data; `untrusted_names` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to list sounds from'),
  },
  outputSchema: {
    sounds: z.array(
      z.object({
        sound_id: SoundboardSoundId,
        name: z.string(),
        volume: z.number(),
        emoji_id: z.string().nullable(),
        emoji_name: z.string().nullable(),
        available: z.boolean(),
      }),
    ),
    count: z.number().int(),
    untrusted_names: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const resp = (await container.rest.get(Routes.guildSoundboardSounds(args.guild_id))) as
      | RawSound[]
      | RawListResponse;
    const raw = Array.isArray(resp) ? resp : (resp.items ?? []);
    const sounds = raw.map((s) => ({
      sound_id: s.sound_id,
      name: s.name,
      volume: s.volume,
      emoji_id: s.emoji_id,
      emoji_name: s.emoji_name,
      available: s.available,
    }));
    const untrusted = wrapUntrusted(
      JSON.stringify(raw.map((s) => ({ sound_id: s.sound_id, name: s.name }))),
      'username',
    );
    return dualResult({
      text: `Found ${sounds.length} soundboard sound(s) in guild \`${args.guild_id}\`.`,
      data: { sounds, count: sounds.length, untrusted_names: untrusted },
    });
  },
});
