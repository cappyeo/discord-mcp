import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { EmojiId, GuildId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'emojis_delete',
  category: 'emojis',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a custom guild emoji. **DESTRUCTIVE — IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Retire a stale or off-brand emoji.',
    '',
    '**When NOT to use**:',
    '- Application emoji → use `app_emojis_delete`.',
    '',
    '**Returns**: `{deleted, guild_id, emoji_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild owning the emoji'),
    emoji_id: EmojiId.describe('Emoji to delete'),
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
    emoji_id: EmojiId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildEmoji(args.guild_id, args.emoji_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted emoji \`${args.emoji_id}\` from guild \`${args.guild_id}\`.`,
      data: {
        deleted: true as const,
        guild_id: args.guild_id,
        emoji_id: args.emoji_id,
      },
    });
  },
});
