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
  token?: string;
}

export default defineTool({
  name: 'webhooks_get_with_token',
  category: 'webhooks',
  description: [
    '**Purpose**: Get a webhook by id + token without bot auth.',
    '',
    '**When to use**:',
    '- You hold the token (e.g. from `webhooks_create`) but lack guild access.',
    '',
    '**Auth**: Sends NO `Authorization: Bot …` header — Discord rejects bot auth on token routes.',
    '',
    '**Returns**: Webhook record. `token` is preserved here (the caller already has it). `name` remains raw creator-controlled data; `untrusted_name` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to fetch'),
    token: WebhookToken.describe('Webhook secret — treat as credential, do not log'),
  },
  outputSchema: {
    id: WebhookId,
    type: z.number().int(),
    channel_id: ChannelId.nullable(),
    application_id: ApplicationId.nullable(),
    name: z.string().nullable(),
    avatar: z.string().nullable(),
    token: WebhookToken.optional(),
    untrusted_name: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const wh = (await container.rest.get(Routes.webhook(args.webhook_id, args.token), {
      auth: false,
    })) as RawWebhook;
    const wrapped = wrapUntrusted(wh.name ?? '', 'username');
    return dualResult({
      text: `Webhook \`${wh.id}\` (token-auth lookup).`,
      data: {
        id: wh.id,
        type: wh.type,
        channel_id: wh.channel_id,
        application_id: wh.application_id,
        name: wh.name,
        avatar: wh.avatar,
        token: wh.token,
        untrusted_name: wrapped,
      },
    });
  },
});
