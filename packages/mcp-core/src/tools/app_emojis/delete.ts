import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, EmojiId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'app_emojis_delete',
  category: 'app_emojis',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete an application emoji. **DESTRUCTIVE — IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Retire an obsolete app emoji.',
    '',
    '**When NOT to use**:',
    '- Guild emoji → use `emojis_delete`.',
    '',
    '**Returns**: `{deleted, application_id, emoji_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Application owning the emoji'),
    emoji_id: EmojiId.describe('Emoji to delete'),
  },
  outputSchema: {
    deleted: z.literal(true),
    application_id: ApplicationId,
    emoji_id: EmojiId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.applicationEmoji(args.application_id, args.emoji_id));
    return dualResult({
      text: `Deleted app emoji \`${args.emoji_id}\` from application \`${args.application_id}\`.`,
      data: {
        deleted: true as const,
        application_id: args.application_id,
        emoji_id: args.emoji_id,
      },
    });
  },
});
