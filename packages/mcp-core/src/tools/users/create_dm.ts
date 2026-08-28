import { container } from '@sapphire/pieces';
import { TaskCancelledError } from 'cockatiel';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { USER_SCOPED_ACCESS } from '../../access/requirements.js';
import { DmOutcomeUnknown } from '../../errors/client.js';
import { classifyDiscordError } from '../../rest/errors.js';
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
    __consent: z.boolean().optional().describe('Explicitly approve contacting this recipient'),
    __consent_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional()
      .describe('SHA-256 hash returned by the consent preview'),
    __consent_id: z
      .uuid()
      .optional()
      .describe('One-time consent approval ID returned by the preview'),
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
  access: USER_SCOPED_ACCESS,
  idempotent: true,
  handler: async (args, ctx) => {
    let ch: RawDMChannel;
    try {
      ch = (await container.rest.post(Routes.userChannels(), {
        body: { recipient_id: args.recipient_id },
      })) as RawDMChannel;
    } catch (error) {
      // A policy timeout can happen after Discord accepted the request. A
      // caller-initiated abort is different and is handled by the outer MCP
      // cancellation path, so only classify ambiguous internal cancellation.
      if (!ctx.signal.aborted && error instanceof TaskCancelledError) {
        throw new DmOutcomeUnknown(args.recipient_id);
      }
      const classified = classifyDiscordError(error, { method: 'post' });
      if (classified !== null && !classified.replaySafe) {
        throw new DmOutcomeUnknown(args.recipient_id);
      }
      throw error;
    }
    const recipient_ids = (ch.recipients ?? []).map((r) => r.id);
    return dualResult({
      text: `Opened DM channel \`${ch.id}\` with user \`${args.recipient_id}\`.`,
      data: { channel_id: ch.id, type: ch.type, recipient_ids },
    });
  },
});
