import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, StickerId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'stickers_delete_guild_sticker',
  category: 'stickers',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a guild sticker. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Retire a stale or off-brand sticker.',
    '',
    '**Returns**: `{deleted, guild_id, sticker_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild owning the sticker'),
    sticker_id: StickerId.describe('Sticker to delete'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    guild_id: GuildId,
    sticker_id: StickerId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildSticker(args.guild_id, args.sticker_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted sticker \`${args.sticker_id}\` from guild \`${args.guild_id}\`.`,
      data: {
        deleted: true as const,
        guild_id: args.guild_id,
        sticker_id: args.sticker_id,
      },
    });
  },
});
