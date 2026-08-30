import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'messages_unpin',
  category: 'messages',
  description: [
    '**Purpose**: Remove a pinned message from a channel.',
    '',
    '**When to use**:',
    '- Rotate pinned content; un-stick stale announcements.',
    '',
    '**When NOT to use**:',
    '- Removing the message itself → use `messages_delete` (this only un-pins).',
    '',
    '**Returns**: `{unpinned, channel_id, message_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to unpin'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    unpinned: z.literal(true),
    channel_id: ChannelId,
    message_id: MessageId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.channelMessagesPin(args.channel_id, args.message_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Unpinned message ${args.message_id} from <#${args.channel_id}>.`,
      data: {
        unpinned: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
      },
    });
  },
});
