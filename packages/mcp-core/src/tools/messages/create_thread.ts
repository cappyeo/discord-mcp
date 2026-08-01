import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
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
    '**Purpose**: Start a public thread anchored to an existing message.',
    '',
    '**When to use**:',
    '- Spin up discussion off of an announcement or proposal.',
    '',
    '**When NOT to use**:',
    '- Forum channels - use `channels_forum_create_thread` (Phase B).',
    '- Standalone (un-anchored) thread - use a non-message thread tool once available.',
    '',
    '**Example**: `{channel_id:"111122223333444401", message_id:"999000999000999000", name:"Discussion"}`',
    '',
    '**Returns**: `{thread_id, name, parent_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Parent channel containing the anchor message'),
    message_id: MessageId.describe('Message to anchor the thread to'),
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
  handler: async (args) => {
    const body: Record<string, unknown> = { name: args.name };
    if (args.auto_archive_duration !== undefined)
      body.auto_archive_duration = args.auto_archive_duration;
    if (args.rate_limit_per_user !== undefined) body.rate_limit_per_user = args.rate_limit_per_user;

    const t = (await container.rest.post(Routes.threads(args.channel_id, args.message_id), {
      body,
      reason: args.audit_reason,
    })) as RawChannel;

    return dualResult({
      text: `Created thread '${t.name}' (\`${t.id}\`) under message ${args.message_id}.`,
      data: {
        thread_id: t.id,
        name: t.name,
        parent_id: t.parent_id ?? null,
      },
    });
  },
});
