import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, ChannelId, MessageId, WebhookToken } from '../_lib/snowflake.js';

interface RawMessage {
  id: string;
  channel_id: string;
}

export default defineTool({
  name: 'interactions_edit_original_response',
  category: 'interactions',
  description: [
    '**Purpose**: Edit the original interaction response (e.g. fill in a deferred reply).',
    '',
    '**Auth**: token-secured (NO bot token).',
    '',
    '**Body** mirrors a webhook execute body: `content`, `embeds`, `components`, `attachments`, `allowed_mentions`, `payload_json`, `flags`, `poll`. `null` clears.',
    '',
    '**Returns**: `{message_id, channel_id}` after the edit.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    interaction_token: WebhookToken.describe(
      'Scoped interaction credential, reusable for follow-ups for up to 15 minutes',
    ),
    content: z.string().max(2000).nullable().optional(),
    embeds: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    components: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    allowed_mentions: z.record(z.string(), z.unknown()).nullable().optional(),
    payload_json: z.string().optional(),
    flags: z
      .number()
      .int()
      .optional()
      .describe('Message flags bitfield. V2 layout = 1<<15 = 32768.'),
    poll: z.record(z.string(), z.unknown()).optional(),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    const passthrough = [
      'content',
      'embeds',
      'components',
      'attachments',
      'allowed_mentions',
      'payload_json',
      'flags',
      'poll',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const m = (await container.rest.patch(
      Routes.webhookMessage(args.application_id, args.interaction_token, '@original'),
      { body, auth: false },
    )) as RawMessage;
    return dualResult({
      text: `Edited original interaction message \`${m.id}\`.`,
      data: { message_id: m.id, channel_id: m.channel_id },
    });
  },
});
