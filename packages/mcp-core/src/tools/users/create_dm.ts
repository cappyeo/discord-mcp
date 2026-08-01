import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, UserId } from '../_lib/snowflake.js';

interface RawDMChannel {
  id: string;
  type: number;
  recipients?: Array<{ id: string; username: string }>;
}

export default defineTool({
  name: 'users_create_dm',
  category: 'users',
  description: [
    '**Purpose**: Open (or fetch) a DM channel between the bot and a user (`POST /users/@me/channels`).',
    '',
    '**When to use**:',
    '- Send a private message to a user - Discord requires a DM channel id first.',
    '',
    '**Idempotent**: repeat calls return the same DM channel id.',
    '',
    '**Note**: User-scoped endpoint - does NOT accept `audit_reason`.',
    '',
    '**Returns**: `{channel_id, type, recipient_ids}`. Use `channel_id` with `messages_send` to deliver the DM.',
  ].join('\n'),
  inputSchema: {
    recipient_id: UserId.describe('User to DM'),
  },
  outputSchema: {
    channel_id: ChannelId,
    type: z.number().int(),
    recipient_ids: z.array(UserId),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const ch = (await container.rest.post(Routes.userChannels(), {
      body: { recipient_id: args.recipient_id },
    })) as RawDMChannel;
    const recipient_ids = (ch.recipients ?? []).map((r) => r.id);
    return dualResult({
      text: `Opened DM channel \`${ch.id}\` with user \`${args.recipient_id}\`.`,
      data: { channel_id: ch.id, type: ch.type, recipient_ids },
    });
  },
});
