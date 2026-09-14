import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';
import {
  messageFields,
  projectMessage,
  type RawMessage,
  readableMessageContent,
} from './_lib/message.js';

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
    '**Returns**: `{message_id, channel_id, author_id, author_name, content, components?, embeds?, attachments?, flags?, timestamp, edited, pinned}`. This is a selected message projection, not the entire Discord message. `content` is unchanged; rich fields are preserved in full when supplied by Discord, including unknown component types. Empty or absent upstream fields stay empty or absent.',
    '',
    '**Readable text**: The human-readable MCP response derives text from original content, nested Text Display components in order, then embed author/title/description/fields/footer. All derived text is fenced as untrusted Discord data; raw structured fields are also untrusted. Attachment and media URLs are metadata only and are not fetched.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to fetch'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    ...messageFields,
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
          content: readableMessageContent(m),
        },
      ],
      m.channel_id,
    );
    return dualResult({
      text: wrapped,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        ...projectMessage(m),
        pinned: m.pinned ?? false,
      },
    });
  },
});
