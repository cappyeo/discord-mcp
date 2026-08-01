import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';

interface RawPinnedMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null };
  timestamp: string;
}

export default defineTool({
  name: 'messages_list_pins',
  category: 'messages',
  description: [
    '**Purpose**: List the pinned messages in a channel.',
    '',
    '**When to use**:',
    '- Surface persistent pinned content (FAQs, rules, announcements).',
    '',
    '**When NOT to use**:',
    '- Reading recent activity → use `messages_read`.',
    '',
    '**Returns**: `{pins:[{message_id, author_id, author_name, content, timestamp}], count, channel_id}`. Structured pin fields remain raw Discord data; the human-readable MCP `content` response fences message text.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to inspect'),
  },
  outputSchema: {
    pins: z.array(
      z.object({
        message_id: MessageId,
        author_id: UserId,
        author_name: z.string(),
        content: z.string(),
        timestamp: z.string(),
      }),
    ),
    count: z.number().int(),
    channel_id: ChannelId,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(
      Routes.channelPins(args.channel_id),
    )) as RawPinnedMessage[];
    const pins = raw.map((m) => ({
      message_id: m.id,
      author_id: m.author.id,
      author_name: m.author.global_name ?? m.author.username,
      content: m.content,
      timestamp: m.timestamp,
    }));
    const wrappedText = wrapMessages(
      raw.map((m) => ({
        id: m.id,
        author: m.author.global_name ?? m.author.username,
        content: m.content,
      })),
      args.channel_id,
    );
    return dualResult({
      text: wrappedText,
      data: { pins, count: pins.length, channel_id: args.channel_id },
    });
  },
});
