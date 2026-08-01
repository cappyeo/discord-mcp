import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'messages_bulk_delete',
  category: 'messages',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Bulk-delete 2-100 messages from a channel in one request. **DESTRUCTIVE — IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Sweep spam / raid messages.',
    '- Bulk cleanup after a moderation incident.',
    '',
    '**When NOT to use**:',
    '- Single message → use `messages_delete`.',
    '- Messages older than 14 days — Discord rejects with 400.',
    '',
    '**Example**: `{channel_id:"111122223333444455", message_ids:["111122223333444456","111122223333444457"], __confirm:true}`',
    '',
    '**Returns**: `{deleted, channel_id, count}`.',
    '',
    '**Security**: gated by `ConfirmRequired` precondition. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the messages'),
    message_ids: z
      .array(MessageId)
      .min(2, 'bulk delete requires at least 2 message IDs')
      .max(100, 'bulk delete accepts at most 100 message IDs')
      .describe('Message IDs to delete (2-100, all must be ≤14 days old)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    channel_id: ChannelId,
    count: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.post(Routes.channelBulkDelete(args.channel_id), {
      body: { messages: args.message_ids },
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Bulk-deleted ${args.message_ids.length} messages from <#${args.channel_id}>.`,
      data: {
        deleted: true as const,
        channel_id: args.channel_id,
        count: args.message_ids.length,
      },
    });
  },
});
