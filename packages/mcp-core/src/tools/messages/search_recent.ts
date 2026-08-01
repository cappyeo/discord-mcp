import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';

interface RawDiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null };
  timestamp: string;
  edited_timestamp: string | null;
}

export default defineTool({
  name: 'messages_search_recent',
  category: 'messages',
  description: [
    '**Purpose**: Substring-search recent messages in a channel.',
    '',
    '**When to use**:',
    '- Locate a recently sent message by keyword without iterating manually.',
    '',
    '**When NOT to use**:',
    '- Server-wide search → not supported by Discord REST. This tool only fans out the most recent N messages of ONE channel and filters client-side. For deep history, use external indexing.',
    '',
    '**Example**: `{channel_id:"111122223333444401", query:"deploy", limit:100}`',
    '',
    '**Returns**: `{matches:[…], scanned_count, channel_id, query}`. Structured matches remain raw Discord data; the human-readable MCP `content` response fences matched message text.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to scan'),
    query: z.string().min(1).max(200).describe('Substring to match (case-insensitive)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100)
      .describe('Max recent messages to scan (1-100, default 100). NOT a result cap.'),
    before: MessageId.optional().describe('Scan window: messages before this ID (older)'),
    after: MessageId.optional().describe('Scan window: messages after this ID (newer)'),
  },
  outputSchema: {
    matches: z.array(
      z.object({
        message_id: MessageId,
        author_id: UserId,
        author_name: z.string(),
        content: z.string(),
        timestamp: z.string(),
      }),
    ),
    scanned_count: z.number().int(),
    channel_id: ChannelId,
    query: z.string(),
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
    if (args.before !== undefined) query.set('before', args.before);
    if (args.after !== undefined) query.set('after', args.after);

    const raw = (await container.rest.get(Routes.channelMessages(args.channel_id), {
      query,
    })) as RawDiscordMessage[];

    const needle = args.query.toLowerCase();
    const matchedRaw = raw.filter((m) => m.content.toLowerCase().includes(needle));
    const matches = matchedRaw.map((m) => ({
      message_id: m.id,
      author_id: m.author.id,
      author_name: m.author.global_name ?? m.author.username,
      content: m.content,
      timestamp: m.timestamp,
    }));
    const wrappedText = wrapMessages(
      matchedRaw.map((m) => ({
        id: m.id,
        author: m.author.global_name ?? m.author.username,
        content: m.content,
      })),
      args.channel_id,
    );

    return dualResult({
      text: wrappedText,
      data: {
        matches,
        scanned_count: raw.length,
        channel_id: args.channel_id,
        query: args.query,
      },
    });
  },
});
