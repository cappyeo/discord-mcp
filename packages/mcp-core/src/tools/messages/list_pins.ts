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

interface RawPinnedItem {
  pinned_at: string;
  message: RawPinnedMessage;
}

interface RawPinnedList {
  items: RawPinnedItem[];
  has_more: boolean;
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
    "**Pagination**: pass `before` (ISO 8601 timestamp from a prior `pinned_at`) and `limit` (1-50). When `has_more` is true, `next_before` is the last item's `pinned_at` for the next page.",
    '',
    '**Returns**: `{pins:[{message_id, author_id, author_name, content, timestamp, pinned_at}], has_more, next_before?, count, channel_id}`. Structured pin fields remain raw Discord data; the human-readable MCP `content` response fences message text.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to inspect'),
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('ISO 8601 timestamp; return pins created before this'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(50)
      .describe('Maximum pins to fetch (1-50, default 50)'),
  },
  outputSchema: {
    pins: z.array(
      z.object({
        message_id: MessageId,
        author_id: UserId,
        author_name: z.string(),
        content: z.string(),
        timestamp: z.string(),
        pinned_at: z.string().datetime({ offset: true }),
      }),
    ),
    has_more: z.boolean(),
    next_before: z.string().datetime({ offset: true }).optional(),
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
    const query = new URLSearchParams({ limit: String(args.limit ?? 50) });
    if (args.before !== undefined) query.set('before', args.before);
    const raw = (await container.rest.get(Routes.channelMessagesPins(args.channel_id), {
      query,
    })) as RawPinnedList;
    const pins = raw.items.map(({ message: m, pinned_at }) => ({
      message_id: m.id,
      author_id: m.author.id,
      author_name: m.author.global_name ?? m.author.username,
      content: m.content,
      timestamp: m.timestamp,
      pinned_at,
    }));
    const wrappedText = wrapMessages(
      raw.items.map(({ message: m }) => ({
        id: m.id,
        author: m.author.global_name ?? m.author.username,
        content: m.content,
      })),
      args.channel_id,
    );
    return dualResult({
      text: wrappedText,
      data: {
        pins,
        has_more: raw.has_more,
        ...(raw.has_more && pins.length > 0
          ? { next_before: pins[pins.length - 1]!.pinned_at }
          : {}),
        count: pins.length,
        channel_id: args.channel_id,
      },
    });
  },
});
