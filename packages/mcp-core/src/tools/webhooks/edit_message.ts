import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, WebhookId, WebhookToken } from '../_lib/snowflake.js';

interface RawMessage {
  id: string;
  channel_id: string;
}

export default defineTool({
  name: 'webhooks_edit_message',
  category: 'webhooks',
  description: [
    '**Purpose**: Edit a message previously sent by this webhook.',
    '',
    '**When to use**:',
    '- Update an alert that has been resolved, fix a typo, swap V2 layouts.',
    '',
    '**Prefer instead**:',
    '- `components_v2_edit` for V2 layouts (this is the low-level escape hatch - V2 validation is intentionally `z.record`).',
    '',
    '**Auth**: NO `Authorization: Bot …` header.',
    '',
    '**Body** mirrors `webhooks_execute` minus `thread_name`. `thread_id` is a query param, not a body field.',
    '',
    '**Returns**: `{message_id, channel_id}` after the edit.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook id'),
    token: WebhookToken.describe('Webhook secret - treat as credential, do not log'),
    message_id: MessageId.describe('Message to edit'),
    thread_id: ChannelId.optional().describe('Query param: thread the message lives in'),
    content: z.string().max(2000).nullable().optional(),
    embeds: z
      .array(z.record(z.string(), z.unknown()))
      .nullable()
      .optional()
      .describe('Pass `[]` or null to clear embeds.'),
    allowed_mentions: z.record(z.string(), z.unknown()).nullable().optional(),
    components: z
      .array(z.record(z.string(), z.unknown()))
      .nullable()
      .optional()
      .describe(
        'Pass `[]` or null to clear components. Prefer `components_v2_edit` for V2 layouts.',
      ),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    payload_json: z.string().optional(),
    flags: z
      .number()
      .int()
      .optional()
      .describe('V2 layout flag = 1<<15 = 32768. Setting V2 requires components.'),
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
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    const passthrough = [
      'content',
      'embeds',
      'allowed_mentions',
      'components',
      'attachments',
      'payload_json',
      'flags',
      'poll',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const query = new URLSearchParams();
    if (args.thread_id !== undefined) query.set('thread_id', args.thread_id);

    const m = (await container.rest.patch(
      Routes.webhookMessage(args.webhook_id, args.token, args.message_id),
      { body, query, auth: false },
    )) as RawMessage;
    return dualResult({
      text: `Edited webhook message \`${m.id}\`.`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
      },
    });
  },
});
