import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { ReactionEmoji } from '../_lib/reaction-emoji.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'reactions_delete_user',
  category: 'reactions',
  description: [
    "**Purpose**: Remove a specific user's reaction from a message (mod action).",
    '',
    '**When to use**:',
    '- Strip an offending user reaction without clearing the whole emoji.',
    '',
    '**When NOT to use**:',
    "- Bot's own reaction → use `reactions_delete_own`.",
    '- Clearing every user for an emoji → use `reactions_delete_all` with `emoji`.',
    '',
    '**Returns**: `{deleted, channel_id, message_id, emoji, user_id}`. Requires Manage Messages.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to update'),
    emoji: ReactionEmoji.describe('Raw Unicode emoji or `name:id` for custom emoji'),
    user_id: UserId.describe('User whose reaction to remove'),
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
    emoji: z.string(),
    user_id: UserId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(
      Routes.channelMessageUserReaction(args.channel_id, args.message_id, args.emoji, args.user_id),
      { reason: args.audit_reason },
    );
    return dualResult({
      text: `Removed reaction ${args.emoji} by <@${args.user_id}> from message ${args.message_id}.`,
      data: {
        deleted: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
        user_id: args.user_id,
      },
    });
  },
});
