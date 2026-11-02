import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { REACTION_TYPE } from '../_lib/discord-enums.js';
import { ReactionEmoji } from '../_lib/reaction-emoji.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';

interface RawUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export default defineTool({
  name: 'reactions_list',
  category: 'reactions',
  description: [
    '**Purpose**: List users who reacted to a message with a specific emoji.',
    '',
    '**When to use**:',
    '- Inspect poll results; identify upvoters.',
    '',
    '**When NOT to use**:',
    '- Need ALL emojis on the message → fetch the message via `messages_get`.',
    '',
    '**Example**: `{channel_id:"111122223333444401", message_id:"999000999000999000", emoji:"👍", limit:25}`',
    '',
    '**Returns**: `{users:[{user_id, username, bot}], count, channel_id, message_id, emoji}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to inspect'),
    emoji: ReactionEmoji.describe('Raw Unicode emoji or `name:id` for custom emoji'),
    type: z
      .union([z.literal(REACTION_TYPE[0]), z.literal(REACTION_TYPE[1])])
      .optional()
      .describe('0 = normal (default), 1 = burst (super reactions)'),
    after: UserId.optional().describe('Pagination cursor: get users with id > this'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Max users to return (1-100, default 25)'),
  },
  outputSchema: {
    users: z.array(
      z.object({
        user_id: UserId,
        username: z.string(),
        bot: z.boolean(),
      }),
    ),
    count: z.number().int(),
    channel_id: ChannelId,
    message_id: MessageId,
    emoji: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const query = new URLSearchParams({ limit: String(args.limit) });
    if (args.type !== undefined) query.set('type', String(args.type));
    if (args.after !== undefined) query.set('after', args.after);
    const raw = (await container.rest.get(
      Routes.channelMessageReaction(args.channel_id, args.message_id, args.emoji),
      { query },
    )) as RawUser[];
    const users = raw.map((u) => ({
      user_id: u.id,
      username: u.global_name ?? u.username,
      bot: u.bot ?? false,
    }));
    return dualResult({
      text: `**${users.length} user(s)** reacted with ${args.emoji} on message ${args.message_id}.`,
      data: {
        users,
        count: users.length,
        channel_id: args.channel_id,
        message_id: args.message_id,
        emoji: args.emoji,
      },
    });
  },
});
