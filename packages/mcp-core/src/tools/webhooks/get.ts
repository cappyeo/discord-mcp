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
  token?: string;
}

export default defineTool({
  name: 'webhooks_get',
  category: 'webhooks',
  description: [
    '**Purpose**: Get a webhook by id (bot-authed lookup).',
    '',
    '**When to use**:',
    '- Inspect a webhook you discovered via `webhooks_list_channel` or `webhooks_list_guild`.',
    '',
    '**Asymmetry**: This bot-auth path **strips `token` from the response** — the token is only re-issued by `webhooks_create` and `webhooks_get_with_token`. Use `webhooks_get_with_token` when you already hold the token and want the freshest record.',
    '',
    '**Returns**: Webhook fields without `token`. `name` remains raw creator-controlled data; `untrusted_name` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to fetch'),
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
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const wh = (await container.rest.get(Routes.webhook(args.webhook_id))) as RawWebhook;
    const wrapped = wrapUntrusted(wh.name ?? '', 'username');
    return dualResult({
      text: `Webhook \`${wh.id}\` (token projected out).`,
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
