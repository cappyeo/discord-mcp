import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, StickerId } from '../_lib/snowflake.js';

interface RawSticker {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  format_type: number;
  available?: boolean;
}

export default defineTool({
  name: 'stickers_list_guild',
  category: 'stickers',
  description: [
    '**Purpose**: List custom stickers belonging to a guild.',
    '',
    '**When to use**:',
    '- Inventory guild stickers; pick one for a message.',
    '',
    '**Returns**: `{stickers:[{id, name, tags, format_type, available}], count}`. `description` is omitted from list output for brevity - fetch via `stickers_get_guild_sticker` if needed.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to inspect'),
  },
  outputSchema: {
    stickers: z.array(
      z.object({
        id: StickerId,
        name: z.string(),
        tags: z.string(),
        format_type: z.number().int(),
        available: z.boolean(),
      }),
    ),
    count: z.number().int(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(Routes.guildStickers(args.guild_id))) as RawSticker[];
    const stickers = raw.map((s) => ({
      id: s.id,
      name: s.name,
      tags: s.tags,
      format_type: s.format_type,
      available: s.available ?? true,
    }));
    return dualResult({
      text: `**${stickers.length} guild sticker(s)** in \`guild:${args.guild_id}\`.`,
      data: { stickers, count: stickers.length },
    });
  },
});
