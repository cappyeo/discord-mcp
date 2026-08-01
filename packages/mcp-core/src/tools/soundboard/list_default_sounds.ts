import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { SoundboardSoundId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawSound {
  sound_id: string;
  name: string;
  volume: number;
  emoji_id: string | null;
  emoji_name: string | null;
  available: boolean;
}

export default defineTool({
  name: 'soundboard_list_default_sounds',
  category: 'soundboard',
  description: [
    '**Purpose**: List Discord-provided default soundboard sounds (available globally).',
    '',
    '**Returns**: `{sounds:[{sound_id, name, volume, emoji_id, emoji_name, available}], count, untrusted_names}`. Names remain raw Discord data; `untrusted_names` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {},
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
  handler: async () => {
    const raw = (await container.rest.get(Routes.soundboardDefaultSounds())) as RawSound[];
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
      text: `Found ${sounds.length} default soundboard sound(s).`,
      data: { sounds, count: sounds.length, untrusted_names: untrusted },
    });
  },
});
