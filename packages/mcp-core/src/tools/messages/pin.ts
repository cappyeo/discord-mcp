import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'messages_pin',
  category: 'messages',
  description: [
    '**Purpose**: Pin a message in a channel.',
    '',
    '**When to use**:',
    '- Highlight a community announcement / FAQ in the channel.',
    '',
    '**When NOT to use**:',
    '- Channel already has 50 pins (Discord limit) - call returns 400.',
    '',
    '**Returns**: `{pinned, channel_id, message_id}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message to pin'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    pinned: z.literal(true),
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
    await container.rest.put(Routes.channelPin(args.channel_id, args.message_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Pinned message ${args.message_id} in <#${args.channel_id}>.`,
      data: {
        pinned: true as const,
        channel_id: args.channel_id,
        message_id: args.message_id,
      },
    });
  },
});
