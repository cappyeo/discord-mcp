import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'threads_join',
  category: 'threads',
  description: [
    '**Purpose**: Join the current bot user to a thread.',
    '',
    '**When to use**:',
    '- Bot must be a member to receive thread events / send messages.',
    '',
    '**When NOT to use**:',
    '- Adding another user → use `threads_add_member`.',
    '',
    '**Returns**: `{joined, thread_id}`. Idempotent - re-joining is a no-op.',
  ].join('\n'),
  inputSchema: {
    thread_id: ChannelId.describe('Thread to join'),
  },
  outputSchema: {
    joined: z.literal(true),
    thread_id: ChannelId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.put(Routes.threadMembers(args.thread_id, '@me'));
    return dualResult({
      text: `Joined thread <#${args.thread_id}>.`,
      data: { joined: true as const, thread_id: args.thread_id },
    });
  },
});
