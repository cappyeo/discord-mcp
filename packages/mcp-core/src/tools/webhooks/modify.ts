import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, ChannelId, WebhookId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawWebhook {
  id: string;
  type: number;
  name: string | null;
  avatar: string | null;
  channel_id: string | null;
  application_id: string | null;
}

export default defineTool({
  name: 'webhooks_modify',
  category: 'webhooks',
  description: [
    '**Purpose**: Update a webhook (rename, re-avatar, move to a different channel).',
    '',
    '**When to use**:',
    '- Change the channel a webhook posts to (`channel_id`) - only available on the bot-auth path.',
    '',
    '**Returns**: Updated webhook record without a token. `name` remains raw creator-controlled data; `untrusted_name` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to modify'),
    name: z.string().min(1).max(80).optional().describe('New display name'),
    avatar: z
      .string()
      .nullable()
      .optional()
      .describe('base64-encoded image data URI for the avatar, or null to clear'),
    channel_id: ChannelId.optional().describe('Move the webhook to this channel'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: WebhookId,
    type: z.number().int(),
    channel_id: ChannelId.nullable(),
    application_id: ApplicationId.nullable(),
    name: z.string().nullable(),
    avatar: z.string().nullable(),
    untrusted_name: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.avatar !== undefined) body.avatar = args.avatar;
    if (args.channel_id !== undefined) body.channel_id = args.channel_id;
    const wh = (await container.rest.patch(Routes.webhook(args.webhook_id), {
      body,
      reason: args.audit_reason,
    })) as RawWebhook;
    const wrapped = wrapUntrusted(wh.name ?? '', 'username');
    return dualResult({
      text: `Modified webhook \`${wh.id}\`.`,
      data: {
        id: wh.id,
        type: wh.type,
        channel_id: wh.channel_id,
        application_id: wh.application_id,
        name: wh.name,
        avatar: wh.avatar,
        untrusted_name: wrapped,
      },
    });
  },
});
