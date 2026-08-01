import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, ChannelId, WebhookId, WebhookToken } from '../_lib/snowflake.js';
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
  name: 'webhooks_modify_with_token',
  category: 'webhooks',
  description: [
    '**Purpose**: Update a webhook (name + avatar only) using its token, no bot auth.',
    '',
    '**When to use**:',
    '- You hold the token but lack guild access.',
    '',
    '**Restrictions**:',
    '- Cannot move the webhook (`channel_id` not accepted on this route — use `webhooks_modify`).',
    '- Discord does not record audit reasons on token-auth routes, so `audit_reason` is intentionally absent.',
    '',
    '**Auth**: NO `Authorization: Bot …` header.',
    '',
    '**Returns**: Updated webhook record. `name` remains raw creator-controlled data; `untrusted_name` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to modify'),
    token: WebhookToken.describe('Webhook secret — treat as credential, do not log'),
    name: z.string().min(1).max(80).optional().describe('New display name'),
    avatar: z
      .string()
      .nullable()
      .optional()
      .describe('base64-encoded image data URI, or null to clear'),
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
    const wh = (await container.rest.patch(Routes.webhook(args.webhook_id, args.token), {
      body,
      auth: false,
    })) as RawWebhook;
    const wrapped = wrapUntrusted(wh.name ?? '', 'username');
    return dualResult({
      text: `Modified webhook \`${wh.id}\` (token-auth).`,
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
