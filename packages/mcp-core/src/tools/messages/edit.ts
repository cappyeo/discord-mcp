import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

interface EditedMessage {
  id: string;
  channel_id: string;
  content: string;
  edited_timestamp: string;
}

export default defineTool({
  name: 'messages_edit',
  category: 'messages',
  description:
    '**Purpose**: Edit a Discord message previously sent by this bot.\n\n**When to use**: correct typos; update status text; rewrite embeds.\n\n**When NOT to use**: edit messages NOT sent by this bot - Discord rejects (403).\n\n**Returns**: `{message_id, channel_id, edited_timestamp}`.',
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to edit'),
    content: z.string().min(1).max(2000).describe('New text content (max 2000 chars)'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    edited_timestamp: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const m = (await container.rest.patch(Routes.channelMessage(args.channel_id, args.message_id), {
      body: { content: args.content },
    })) as EditedMessage;
    return dualResult({
      text: `Edited message ${m.id} in <#${m.channel_id}>.`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        edited_timestamp: m.edited_timestamp,
      },
    });
  },
});
