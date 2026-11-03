import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import {
  rethrowAttachFilesDenied,
  toMessageAttachments,
  UploadedAttachments,
} from '../_lib/attachments.js';
import { withAttribution } from '../_lib/attribution.js';
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
    '**Purpose**: Send a plain-text message to a Discord channel, optionally with uploaded files.',
    '',
    '**When to use**:',
    '- Reply to user request like "send X to #channel".',
    '- Programmatic announcements without rich layout.',
    '',
    '**When NOT to use**:',
    '- Rich layout (containers, sections, media galleries) → use `components_v2_send`.',
    '- High-volume delivery → use `webhooks_execute` (avoids bot rate limit).',
    '',
    '**Files**: to attach a local file, call `attachments_prepare_upload`, PUT the bytes to each `upload_url`, then pass `attachments`. `content` is optional when attachments are present.',
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
      .optional()
      .describe('Message text content (max 2000 chars). Required unless attachments are given.'),
    attachments: UploadedAttachments,
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
  handler: async (args, ctx) => {
    const hasAttachments = args.attachments !== undefined && args.attachments.length > 0;
    if (args.content === undefined && !hasAttachments) {
      throw new ValidationError([
        {
          path: 'content',
          message: 'content required unless attachments are given',
          code: 'custom',
        },
      ]);
    }
    const body: Record<string, unknown> = { tts: args.tts ?? false };
    const content = withAttribution(args.content, ctx.caller, 'Sent');
    if (content !== undefined) body.content = content;
    if (args.attachments !== undefined && hasAttachments) {
      body.attachments = toMessageAttachments(args.attachments);
    }

    let msg: DiscordMessageResponse;
    try {
      msg = (await container.rest.post(Routes.channelMessages(args.channel_id), {
        body,
      })) as DiscordMessageResponse;
    } catch (error) {
      if (hasAttachments) rethrowAttachFilesDenied(error, args.channel_id);
      throw error;
    }

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
