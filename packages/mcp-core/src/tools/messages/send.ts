import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { messageJumpUrl } from '../_lib/message-jump-url.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

interface DiscordMessageResponse {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  guild_id?: string;
}

export default defineTool({
  name: 'messages_send',
  category: 'messages',
  description: [
    '**Purpose**: Send a plain-text message to a Discord channel.',
    '',
    '**When to use**:',
    '- Reply to user request like "send X to #channel".',
    '- Programmatic announcements without rich layout.',
    '',
    '**When NOT to use**:',
    '- Rich layout (containers, sections, media galleries) → use `components_v2_send`.',
    '- High-volume delivery → use `webhooks_execute` (avoids bot rate limit).',
    '',
    '**Example**: `{channel_id:"112233445566778899", content:"hello"}`',
    '',
    '**Returns**: `{message_id, channel_id, jump_url, timestamp}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Target channel ID'),
    content: z
      .string()
      .min(1, 'content required (max 2000 chars)')
      .max(2000, 'content max 2000 chars')
      .describe('Message text content (max 2000 chars).'),
    tts: z.boolean().optional().describe('Text-to-speech, default false'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    jump_url: z.string().url(),
    timestamp: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const msg = (await container.rest.post(Routes.channelMessages(args.channel_id), {
      body: { content: args.content, tts: args.tts ?? false },
    })) as DiscordMessageResponse;

    return dualResult({
      text: `Sent message ${msg.id} to <#${msg.channel_id}>.`,
      data: {
        message_id: msg.id,
        channel_id: msg.channel_id,
        jump_url: await messageJumpUrl(msg),
        timestamp: msg.timestamp,
      },
    });
  },
});
