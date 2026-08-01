import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, ChannelId, MessageId, WebhookToken } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';

interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  author?: { id: string; username: string; global_name: string | null };
}

export default defineTool({
  name: 'interactions_get_followup',
  category: 'interactions',
  description: [
    '**Purpose**: Fetch a follow-up message previously created by `interactions_create_followup`.',
    '',
    '**Auth**: token-secured (NO bot token).',
    '',
    '**Returns**: `{message_id, channel_id, content, untrusted_messages}`. `content` remains raw Discord data; `untrusted_messages` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    interaction_token: WebhookToken.describe(
      'Scoped interaction credential, reusable for follow-ups for up to 15 minutes',
    ),
    message_id: MessageId.describe('Follow-up message id'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    content: z.string(),
    untrusted_messages: z.string(),
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
      Routes.webhookMessage(args.application_id, args.interaction_token, args.message_id),
      { auth: false },
    )) as RawMessage;
    const author = m.author?.global_name ?? m.author?.username ?? 'unknown';
    const wrapped = wrapMessages([{ id: m.id, author, content: m.content }], m.channel_id);
    return dualResult({
      text: `Follow-up message \`${m.id}\` in channel \`${m.channel_id}\` (content wrapped untrusted).`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        content: m.content,
        untrusted_messages: wrapped,
      },
    });
  },
});
