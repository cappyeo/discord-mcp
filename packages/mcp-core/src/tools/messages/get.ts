import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';

interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  edited_timestamp: string | null;
  pinned?: boolean;
  type?: number;
}

export default defineTool({
  name: 'messages_get',
  category: 'messages',
  description: [
    '**Purpose**: Fetch a single Discord message by ID.',
    '',
    '**When to use**:',
    '- Inspect a specific message referenced by another tool or by the user.',
    '- Verify message exists / read its current content before editing.',
    '',
    '**When NOT to use**:',
    '- Reading a window of recent messages → use `messages_read`.',
    '',
    '**Example**: `{channel_id:"112233445566778899", message_id:"999000999000999000"}`',
    '',
    '**Returns**: `{message_id, channel_id, author_id, author_name, content, timestamp, edited, pinned}`. Structured message fields remain raw Discord data; the human-readable MCP `content` response fences the message text.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to fetch'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    author_id: UserId,
    author_name: z.string(),
    content: z.string(),
    timestamp: z.string(),
    edited: z.boolean(),
    pinned: z.boolean(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const m = (await container.rest.get(
      Routes.channelMessage(args.channel_id, args.message_id),
    )) as RawMessage;
    const wrapped = wrapMessages(
      [
        {
          id: m.id,
          author: m.author.global_name ?? m.author.username,
          content: m.content,
        },
      ],
      m.channel_id,
    );
    return dualResult({
      text: wrapped,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        author_id: m.author.id,
        author_name: m.author.global_name ?? m.author.username,
        content: m.content,
        timestamp: m.timestamp,
        edited: m.edited_timestamp !== null,
        pinned: m.pinned ?? false,
      },
    });
  },
});
