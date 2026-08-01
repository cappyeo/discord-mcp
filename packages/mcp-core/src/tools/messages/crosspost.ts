import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';

interface RawMessage {
  id: string;
  channel_id: string;
  flags?: number;
}

export default defineTool({
  name: 'messages_crosspost',
  category: 'messages',
  description: [
    '**Purpose**: Publish (crosspost) a message from an Announcement channel to all following channels.',
    '',
    '**When to use**:',
    '- Broadcast an existing announcement to subscriber servers.',
    '',
    '**When NOT to use**:',
    '- Channel is not type 5 (Announcement) - Discord returns 400.',
    '- Sending fresh content → use `messages_send` then `messages_crosspost`.',
    '',
    '**Returns**: `{message_id, channel_id, crossposted}`.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Announcement channel containing the message'),
    message_id: MessageId.describe('Message to publish'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    crossposted: z.literal(true),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const m = (await container.rest.post(
      Routes.channelMessageCrosspost(args.channel_id, args.message_id),
      { reason: args.audit_reason },
    )) as RawMessage;
    return dualResult({
      text: `Crossposted message ${m.id} from <#${m.channel_id}>.`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        crossposted: true as const,
      },
    });
  },
});
