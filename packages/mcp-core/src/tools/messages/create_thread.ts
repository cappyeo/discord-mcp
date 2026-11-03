import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import { withAttributionField } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { THREAD_AUTO_ARCHIVE_DURATION } from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

interface RawChannel {
  id: string;
  name: string;
  parent_id?: string | null;
  type: number;
}

export default defineTool({
  name: 'messages_create_thread',
  category: 'messages',
  description: [
    '**Purpose**: Start a thread, either anchored to an existing message (`message_id` given) or standalone (`message_id` omitted).',
    '',
    '**When to use**:',
    '- Spin up discussion off of an announcement or proposal (anchored; bot needs READ_MESSAGE_HISTORY + CREATE_PUBLIC_THREADS).',
    '- Start a thread with no message to anchor to (omit `message_id`; bot needs only CREATE_PUBLIC_THREADS, or CREATE_PRIVATE_THREADS for `type:12`).',
    '',
    '**When NOT to use**:',
    '- Forum channels - use `channels_forum_create_thread`.',
    '',
    '**Standalone options**: `type` (10 announcement, 11 public default, 12 private) and `invitable` (private only) apply only when `message_id` is omitted.',
    '',
    '**Example**: `{channel_id:"111122223333444401", message_id:"999000999000999000", name:"Discussion"}` or `{channel_id:"111122223333444401", name:"Discussion"}`',
    '',
    '**Returns**: `{thread_id, name, parent_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Parent channel containing the anchor message'),
    message_id: MessageId.optional().describe(
      'Message to anchor the thread to; omit to create a standalone thread (POST /channels/{id}/threads)',
    ),
    name: z.string().min(1).max(100).describe('Thread name (1-100 chars)'),
    auto_archive_duration: z
      .union([
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[0]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[1]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[2]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[3]),
      ])
      .optional()
      .describe('Auto-archive after N minutes (60, 1440, 4320, or 10080)'),
    rate_limit_per_user: z
      .number()
      .int()
      .min(0)
      .max(21600)
      .optional()
      .describe('Slowmode in seconds (0-21600)'),
    type: z
      .union([z.literal(10), z.literal(11), z.literal(12)])
      .optional()
      .describe('Standalone only: thread type 10 announcement, 11 public (default), 12 private'),
    invitable: z
      .boolean()
      .optional()
      .describe('Standalone private threads only: whether non-moderators can add members'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    thread_id: ChannelId,
    name: z.string(),
    parent_id: ChannelId.nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {
      // A thread's name is its only free text; Discord has no topic field here.
      name: withAttributionField(args.name, ctx.caller, 'Created', 100) ?? args.name,
    };
    if (args.auto_archive_duration !== undefined)
      body.auto_archive_duration = args.auto_archive_duration;
    if (args.rate_limit_per_user !== undefined) body.rate_limit_per_user = args.rate_limit_per_user;

    if (
      args.message_id !== undefined &&
      (args.type !== undefined || args.invitable !== undefined)
    ) {
      throw new ValidationError([
        {
          path: args.type !== undefined ? 'type' : 'invitable',
          message: '`type` and `invitable` apply only to standalone threads; omit message_id.',
          code: 'custom',
        },
      ]);
    }
    if (args.invitable !== undefined && args.type !== 12) {
      throw new ValidationError([
        {
          path: 'invitable',
          message: '`invitable` applies only to private threads; set type:12.',
          code: 'custom',
        },
      ]);
    }
    if (args.message_id === undefined) {
      body.type = args.type ?? 11;
      if (args.invitable !== undefined) body.invitable = args.invitable;
    }

    const t = (await container.rest.post(Routes.threads(args.channel_id, args.message_id), {
      body,
      reason: args.audit_reason,
    })) as RawChannel;

    return dualResult({
      text:
        args.message_id === undefined
          ? `Created standalone thread '${t.name}' (\`${t.id}\`) in <#${args.channel_id}>.`
          : `Created thread '${t.name}' (\`${t.id}\`) under message ${args.message_id}.`,
      data: {
        thread_id: t.id,
        name: t.name,
        parent_id: t.parent_id ?? null,
      },
    });
  },
});
