import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { ReactionEmoji } from '../_lib/reaction-emoji.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'reactions_delete_own',
  category: 'reactions',
  description: [
    "**Purpose**: Remove the bot's own reaction from a message.",
    '',
    '**When to use**:',
    '- Roll back an erroneous reaction; clean up after a poll closes.',
    '',
    '**When NOT to use**:',
    "- Removing another user's reaction → use `reactions_delete_user`.",
    '- Clearing all reactions → use `reactions_delete_all`.',
    '',
    '**Returns**: `{deleted, channel_id, message_id, emoji}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to remove the reaction from'),
    emoji: ReactionEmoji.describe('Raw Unicode emoji or `name:id` for custom emoji'),
  },
  outputSchema: {
    deleted: z.literal(true),
    channel_id: ChannelId,
    message_id: MessageId,
    emoji: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(
      Routes.channelMessageOwnReaction(args.channel_id, args.message_id, args.emoji),
    );
    return dualResult({
      text: `Removed bot reaction ${args.emoji} from message ${args.message_id}.`,
      data: {
        deleted: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
      },
    });
  },
});
