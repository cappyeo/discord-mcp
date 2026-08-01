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
  name: 'stickers_modify_guild_sticker',
  category: 'stickers',
  description: [
    "**Purpose**: Update a guild sticker's name, description, or tags.",
    '',
    '**When to use**:',
    '- Rebrand or re-tag an existing sticker.',
    '',
    '**When NOT to use**:',
    '- Replacing the sticker file - Discord does not allow editing the file; create a new one and delete the old.',
    '',
    '**Returns**: `{id, name, description, tags, format_type, available}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild owning the sticker'),
    sticker_id: StickerId.describe('Sticker to modify'),
    name: z.string().min(2).max(30).optional().describe('New name (2-30 chars)'),
    description: z.string().max(100).optional().describe('New description (max 100 chars)'),
    tags: z.string().min(1).max(200).optional().describe('New autocomplete tags (max 200 chars)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
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
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.description !== undefined) body.description = args.description;
    if (args.tags !== undefined) body.tags = args.tags;
    const s = (await container.rest.patch(Routes.guildSticker(args.guild_id, args.sticker_id), {
      body,
      reason: args.audit_reason,
    })) as RawSticker;
    return dualResult({
      text: `Modified sticker ${s.name} (\`sticker:${s.id}\`).`,
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
