import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'reactions_delete_all',
  category: 'reactions',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Clear reactions on a message. Without `emoji`: clears EVERY reaction. With `emoji`: clears just that emoji across all users. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Reset a poll; remove a corrupted reaction set.',
    '- Mod cleanup after spam reactions.',
    '',
    '**When NOT to use**:',
    "- Removing only one user's reaction → use `reactions_delete_user`.",
    '',
    '**Example (clear-all)**: `{channel_id:"…", message_id:"…"}`',
    '**Example (clear-by-emoji)**: `{channel_id:"…", message_id:"…", emoji:"👍"}`',
    '',
    '**Returns**: `{deleted, channel_id, message_id, scope}` where `scope` is `"all"` or `"emoji"`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to clear reactions on'),
    emoji: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('If provided, clear only this emoji; else clear all reactions'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    channel_id: ChannelId,
    message_id: MessageId,
    scope: z.enum(['all', 'emoji']),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    if (args.emoji !== undefined) {
      await container.rest.delete(
        Routes.channelMessageReaction(args.channel_id, args.message_id, args.emoji),
        { reason: args.audit_reason },
      );
      return dualResult({
        text: `Cleared reaction ${args.emoji} from message ${args.message_id}.`,
        data: {
          deleted: true as const,
          channel_id: args.channel_id,
          message_id: args.message_id,
          scope: 'emoji' as const,
        },
      });
    }
    await container.rest.delete(
      Routes.channelMessageAllReactions(args.channel_id, args.message_id),
      { reason: args.audit_reason },
    );
    return dualResult({
      text: `Cleared ALL reactions from message ${args.message_id}.`,
      data: {
        deleted: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
        scope: 'all' as const,
      },
    });
  },
});
