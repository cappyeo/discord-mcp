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

const EPHEMERAL_FLAG = 1 << 6; // 64

export default defineTool({
  name: 'interactions_create_followup',
  category: 'interactions',
  description: [
    '**Purpose**: Send a follow-up message after an interaction has been acknowledged. Useful for long-running work where you replied with a deferred response.',
    '',
    '**Auth**: token-secured (NO bot token).',
    '',
    '**Body** mirrors a webhook execute body. Set `ephemeral:true` to add the EPHEMERAL flag (visible only to the invoking user).',
    '',
    '**Returns**: `{message_id, channel_id}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    interaction_token: WebhookToken.describe(
      'Scoped interaction credential, reusable for follow-ups for up to 15 minutes',
    ),
    content: z.string().max(2000).optional(),
    embeds: z.array(z.record(z.string(), z.unknown())).optional(),
    components: z.array(z.record(z.string(), z.unknown())).optional(),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    allowed_mentions: z.record(z.string(), z.unknown()).optional(),
    tts: z.boolean().optional(),
    flags: z
      .number()
      .int()
      .optional()
      .describe('Message flags bitfield. EPHEMERAL=64, V2 layout=32768.'),
    ephemeral: z
      .boolean()
      .optional()
      .describe('Convenience: when true, OR-in EPHEMERAL (64) into flags.'),
    payload_json: z.string().optional(),
    poll: z.record(z.string(), z.unknown()).optional(),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    const passthrough = [
      'content',
      'embeds',
      'components',
      'attachments',
      'allowed_mentions',
      'tts',
      'payload_json',
      'poll',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    let flags = args.flags;
    if (args.ephemeral === true) flags = (flags ?? 0) | EPHEMERAL_FLAG;
    if (flags !== undefined) body.flags = flags;

    const m = (await container.rest.post(
      Routes.webhook(args.application_id, args.interaction_token),
      { body, auth: false },
    )) as RawMessage;
    return dualResult({
      text: `Sent follow-up message \`${m.id}\` in channel \`${m.channel_id}\`.`,
      data: { message_id: m.id, channel_id: m.channel_id },
    });
  },
});
