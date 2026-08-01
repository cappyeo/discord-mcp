import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, WebhookId, WebhookToken } from '../_lib/snowflake.js';

interface RawMessage {
  id: string;
  channel_id: string;
  webhook_id?: string;
}

export default defineTool({
  name: 'webhooks_execute',
  category: 'webhooks',
  description: [
    '**Purpose**: Execute (send a message through) a webhook. Low-level escape hatch.',
    '',
    '**When to use**:',
    '- You need a webhook-only feature (no bot user) and already hold the token.',
    '',
    '**Prefer instead**:',
    '- `messages_send` for normal bot output.',
    '- `components_v2_send` for V2 component layouts (this tool is the raw escape hatch - V2 validation is intentionally `z.record`).',
    '',
    '**Auth**: NO `Authorization: Bot …` header. Discord rejects bot auth on the execute route.',
    '',
    '**At least one of** `content`, `embeds`, `components`, `attachments`, or `poll` is required.',
    '',
    '**Query params** `wait` and `with_components` are passed in the URL, NOT the body.',
    '',
    '**Returns**: When `wait:true`, `{message_id, channel_id, webhook_id}`. Otherwise `{enqueued:true}`.',
  ].join('\n'),
  // The "at least one of content/embeds/components/attachments/poll" rule is enforced inside
  // the handler - defineTool's per-key inputSchema does not currently surface cross-field refinements.
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook id'),
    token: WebhookToken.describe('Webhook secret - treat as credential, do not log'),
    content: z.string().max(2000).optional().describe('Message text (max 2000 chars)'),
    username: z.string().optional().describe('Override the webhook display name for this message'),
    avatar_url: z.string().optional().describe('Override the webhook avatar URL for this message'),
    tts: z.boolean().optional(),
    embeds: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe('Legacy embeds (V1 layout). For V2 layouts use `components_v2_send`.'),
    allowed_mentions: z.record(z.string(), z.unknown()).optional(),
    components: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe(
        'V1 action rows OR raw V2 component tree. Prefer `components_v2_send` for V2 layouts; this is the low-level escape hatch.',
      ),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    payload_json: z.string().optional(),
    flags: z
      .number()
      .int()
      .optional()
      .describe('Message flags bitfield. V2 layout = 1<<15 = 32768 (IS_COMPONENTS_V2).'),
    thread_id: ChannelId.optional().describe('Post into this thread (forum/text-thread channels)'),
    thread_name: z.string().optional().describe('When the parent is a forum, name the new thread'),
    applied_tags: z
      .array(z.string())
      .optional()
      .describe('Forum tag ids to apply when creating a thread'),
    poll: z.record(z.string(), z.unknown()).optional(),
    with_components: z
      .boolean()
      .optional()
      .describe('Query param: include components in the response message'),
    wait: z
      .boolean()
      .optional()
      .describe('Query param: wait for the message to be created and return it'),
  },
  outputSchema: {
    enqueued: z.boolean().optional(),
    message_id: MessageId.optional(),
    channel_id: ChannelId.optional(),
    webhook_id: WebhookId.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    // Cross-field refinement (mirrors the InputObject .refine - defineTool only knows per-key shapes).
    const hasPayload =
      args.content !== undefined ||
      (args.embeds !== undefined && args.embeds.length > 0) ||
      (args.components !== undefined && args.components.length > 0) ||
      (args.attachments !== undefined && args.attachments.length > 0) ||
      args.poll !== undefined;
    if (!hasPayload) {
      throw new Error(
        'webhooks_execute requires at least one of: content, embeds, components, attachments, poll',
      );
    }

    const body: Record<string, unknown> = {};
    const passthrough = [
      'content',
      'username',
      'avatar_url',
      'tts',
      'embeds',
      'allowed_mentions',
      'components',
      'attachments',
      'payload_json',
      'flags',
      'thread_name',
      'applied_tags',
      'poll',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }

    const query = new URLSearchParams();
    if (args.wait !== undefined) query.set('wait', String(args.wait));
    if (args.with_components !== undefined)
      query.set('with_components', String(args.with_components));
    if (args.thread_id !== undefined) query.set('thread_id', args.thread_id);

    const result = (await container.rest.post(Routes.webhook(args.webhook_id, args.token), {
      body,
      query,
      auth: false,
    })) as RawMessage | null;

    if (args.wait === true && result !== null) {
      return dualResult({
        text: `Executed webhook \`${args.webhook_id}\`; message \`${result.id}\` posted.`,
        data: {
          message_id: result.id,
          channel_id: result.channel_id,
          webhook_id: result.webhook_id ?? args.webhook_id,
        },
      });
    }
    return dualResult({
      text: `Executed webhook \`${args.webhook_id}\` (fire-and-forget; pass wait:true to receive message_id).`,
      data: { enqueued: true },
    });
  },
});
