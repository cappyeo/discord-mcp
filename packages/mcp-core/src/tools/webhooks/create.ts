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
  name: 'webhooks_create',
  category: 'webhooks',
  description: [
    '**Purpose**: Create a new webhook attached to a channel.',
    '',
    '**When to use**:',
    '- Provision an automation endpoint (CI notifier, alert relay, cross-poster).',
    '',
    '**When NOT to use**:',
    '- Sending one-off bot messages → `messages_send`.',
    '',
    '**Returns**: Full webhook record INCLUDING the `token` - store it as a secret. The agent needs the token to call `webhooks_execute`. `name` remains raw creator-controlled data; `untrusted_name` provides a separately fenced copy.',
    '',
    '**Note**: This is the only `webhooks_*_get`-style tool that exposes `token` in its response. `webhooks_get` projects token OUT.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel that will host the webhook'),
    name: z.string().min(1).max(80).describe('Webhook display name (max 80 chars)'),
    avatar: z
      .string()
      .nullable()
      .optional()
      .describe('base64-encoded image data URI for the webhook avatar, or null'),
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
    token: WebhookToken.optional(),
    untrusted_name: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { name: args.name };
    if (args.avatar !== undefined) body.avatar = args.avatar;
    const wh = (await container.rest.post(Routes.channelWebhooks(args.channel_id), {
      body,
      reason: args.audit_reason,
    })) as RawWebhook;
    const wrapped = wrapUntrusted(wh.name ?? '', 'username');
    return dualResult({
      text: `Created webhook \`${wh.id}\` in <#${args.channel_id}>. Token returned - store it as a secret.`,
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
