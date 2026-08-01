import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, StickerId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawSticker {
  id: string;
  pack_id?: string;
  name: string;
  description: string | null;
  tags: string;
  type: number;
  format_type: number;
  available?: boolean;
  guild_id?: string;
  user?: { id: string };
  sort_value?: number;
}

export default defineTool({
  name: 'stickers_get',
  category: 'stickers',
  description: [
    '**Purpose**: Public lookup of a single sticker by ID (no guild context).',
    '',
    '**When to use**:',
    '- Resolve a sticker ID surfaced in a message or pack response.',
    '',
    '**Returns**: `{id, name, description, tags, type, format_type, guild_id?}`. Structured `description` remains raw user-authored data; the human-readable text response fences it.',
  ].join('\n'),
  inputSchema: {
    sticker_id: StickerId.describe('Sticker to fetch'),
  },
  outputSchema: {
    id: StickerId,
    name: z.string(),
    description: z.string().nullable(),
    tags: z.string(),
    type: z.number().int(),
    format_type: z.number().int(),
    available: z.boolean(),
    guild_id: GuildId.optional(),
    user_id: UserId.optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const s = (await container.rest.get(Routes.sticker(args.sticker_id))) as RawSticker;
    const descWrapped =
      s.description !== null && s.description !== undefined
        ? wrapUntrusted(s.description, 'embed')
        : '_(no description)_';
    const data: Record<string, unknown> = {
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      type: s.type,
      format_type: s.format_type,
      available: s.available ?? true,
    };
    if (s.guild_id !== undefined) data.guild_id = s.guild_id;
    if (s.user?.id !== undefined) data.user_id = s.user.id;
    return dualResult({
      text: `**Sticker** ${s.name} (\`sticker:${s.id}\`)\n${descWrapped}`,
      data,
    });
  },
});
