import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'reactions_create',
  category: 'reactions',
  description: [
    "**Purpose**: Add the bot's own reaction to a message.",
    '',
    '**When to use**:',
    '- Acknowledge a message; signal a vote/poll preference; quick affirmation.',
    '',
    '**When NOT to use**:',
    '- Reacting on behalf of another user - not possible via REST.',
    '',
    '**Example**: `{channel_id:"111122223333444401", message_id:"999000999000999000", emoji:"thumbsup:850000000000000001"}`',
    '',
    '**Returns**: `{reacted, channel_id, message_id, emoji}`. `emoji` accepts unicode (e.g. `"👍"`) OR `name:id` for custom emojis. URL-encoding is handled by `@discordjs/rest`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to react to'),
    emoji: z
      .string()
      .min(1)
      .max(128)
      .describe('Unicode emoji (e.g. "👍") or `name:id` for custom emoji'),
  },
  outputSchema: {
    reacted: z.literal(true),
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
    await container.rest.put(
      Routes.channelMessageOwnReaction(args.channel_id, args.message_id, args.emoji),
    );
    return dualResult({
      text: `Added reaction ${args.emoji} to message ${args.message_id}.`,
      data: {
        reacted: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
      },
    });
  },
});
