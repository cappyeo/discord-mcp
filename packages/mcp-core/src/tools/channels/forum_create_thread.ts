import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { THREAD_AUTO_ARCHIVE_DURATION } from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

interface RawForumThread {
  id: string;
  parent_id?: string | null;
  message?: { id: string };
}

export default defineTool({
  name: 'channels_forum_create_thread',
  category: 'channels',
  description: [
    '**Purpose**: Create a new forum (or media) thread with an initial message in one request.',
    '',
    '**When to use**:',
    '- Forum-channel onboarding flows; programmatic question/answer post creation.',
    '',
    '**When NOT to use**:',
    '- Anchored thread on an existing message → use `messages_create_thread`.',
    '- Plain text channels - Discord rejects.',
    '',
    '**Body shape**: requires nested `message` (the initial post). At least one of `message.content`, `message.embeds`, or `message.components` must be present.',
    '',
    '**Returns**: `{thread_id, parent_id, message_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Parent forum/media channel'),
    name: z.string().min(1).max(100).describe('Thread (post) name (1-100 chars)'),
    auto_archive_duration: z
      .union([
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[0]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[1]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[2]),
        z.literal(THREAD_AUTO_ARCHIVE_DURATION[3]),
      ])
      .optional()
      .describe('Auto-archive after N minutes (60, 1440, 4320, or 10080)'),
    rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
    applied_tags: z.array(z.string()).optional().describe('Forum tag IDs to apply to the thread'),
    message: z
      .object({
        content: z.string().max(4000).optional(),
        embeds: z.array(z.record(z.string(), z.unknown())).optional(),
        components: z.array(z.record(z.string(), z.unknown())).optional(),
        attachments: z.array(z.record(z.string(), z.unknown())).optional(),
        flags: z.number().int().optional(),
      })
      .describe('Initial forum post body. At least one of content/embeds/components required.'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    thread_id: ChannelId,
    parent_id: ChannelId.nullable(),
    message_id: MessageId.nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { name: args.name, message: args.message };
    if (args.auto_archive_duration !== undefined)
      body.auto_archive_duration = args.auto_archive_duration;
    if (args.rate_limit_per_user !== undefined) body.rate_limit_per_user = args.rate_limit_per_user;
    if (args.applied_tags !== undefined) body.applied_tags = args.applied_tags;
    const t = (await container.rest.post(Routes.threads(args.channel_id), {
      body,
      reason: args.audit_reason,
    })) as RawForumThread;
    return dualResult({
      text: `Created forum thread \`${t.id}\` under <#${args.channel_id}>.`,
      data: {
        thread_id: t.id,
        parent_id: t.parent_id ?? null,
        message_id: t.message?.id ?? null,
      },
    });
  },
});
