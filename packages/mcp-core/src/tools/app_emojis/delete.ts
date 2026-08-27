import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { resolveApplicationId } from '../_lib/application.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, EmojiId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'app_emojis_delete',
  category: 'app_emojis',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete an application emoji. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Retire an obsolete app emoji.',
    '- Omit `application_id` to delete from the authenticated bot application.',
    '',
    '**When NOT to use**:',
    '- Guild emoji → use `emojis_delete`.',
    '',
    '**Returns**: `{deleted, application_id, emoji_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.optional().describe(
      'Application owning the emoji (omit to use the authenticated bot application)',
    ),
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
  handler: async (args, ctx) => {
    const applicationId = await resolveApplicationId(
      container.rest,
      args.application_id,
      ctx?.signal,
    );
    await container.rest.delete(Routes.applicationEmoji(applicationId, args.emoji_id));
    return dualResult({
      text: `Deleted app emoji \`${args.emoji_id}\` from application \`${applicationId}\`.`,
      data: {
        deleted: true as const,
        application_id: applicationId,
        emoji_id: args.emoji_id,
      },
    });
  },
});
