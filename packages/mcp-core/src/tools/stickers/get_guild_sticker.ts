import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, StickerId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawSticker {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  format_type: number;
  available?: boolean;
}

export default defineTool({
  name: 'stickers_get_guild_sticker',
  category: 'stickers',
  description: [
    '**Purpose**: Fetch a single guild sticker including description and tags.',
    '',
    '**When to use**:',
    '- Inspect description / tags / availability of a known sticker.',
    '',
    '**Returns**: `{id, name, description, tags, format_type, available}`. Structured `description` remains raw moderator-authored data; the human-readable text response fences it.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild owning the sticker'),
    sticker_id: StickerId.describe('Sticker to fetch'),
  },
  outputSchema: {
    id: StickerId,
    name: z.string(),
    description: z.string().nullable(),
    tags: z.string(),
    format_type: z.number().int(),
    available: z.boolean(),
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
      Routes.guildSticker(args.guild_id, args.sticker_id),
    )) as RawSticker;
    const descWrapped =
      s.description !== null && s.description !== undefined
        ? wrapUntrusted(s.description, 'embed')
        : '_(no description)_';
    return dualResult({
      text: `**Sticker** ${s.name} (\`sticker:${s.id}\`)\n${descWrapped}`,
      data: {
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
        format_type: s.format_type,
        available: s.available ?? true,
      },
    });
  },
});
