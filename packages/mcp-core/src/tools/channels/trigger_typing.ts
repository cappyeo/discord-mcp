import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'channels_trigger_typing',
  category: 'channels',
  description: [
    '**Purpose**: Show the bot as typing in a channel for ~10 seconds.',
    '',
    '**When to use**:',
    '- Indicate a long-running operation is producing a response.',
    '',
    '**When NOT to use**:',
    '- Replacement for actual messages - typing indicator alone does not deliver content.',
    '',
    '**Returns**: `{ok, channel_id}`. Idempotent - repeat calls extend the indicator.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to type in'),
  },
  outputSchema: {
    ok: z.literal(true),
    channel_id: ChannelId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.post(Routes.channelTyping(args.channel_id));
    return dualResult({
      text: `Triggered typing indicator in <#${args.channel_id}>.`,
      data: { ok: true as const, channel_id: args.channel_id },
    });
  },
});
