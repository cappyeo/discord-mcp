import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawUser {
  id: string;
  username: string;
  discriminator: string;
  global_name: string | null;
}

interface RawVoters {
  users: RawUser[];
}

export default defineTool({
  name: 'polls_get_voters',
  category: 'polls',
  description: [
    '**Purpose**: List users who voted for a specific answer on a poll.',
    '',
    '**Path**: `/channels/{channel.id}/polls/{message.id}/answers/{answer_id}`. `answer_id` is a poll-local integer (NOT a snowflake).',
    '',
    '**Returns**: `{voters:[{id, username}], count, untrusted_text}`. Usernames remain raw Discord data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the poll message'),
    message_id: MessageId.describe('Poll message ID'),
    answer_id: z.number().int().min(1).describe('Poll answer ID (integer, not snowflake)'),
    after: UserId.optional().describe('Cursor: only voters with id > this'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max voters to return (1..100, default 25)'),
  },
  outputSchema: {
    voters: z.array(
      z.object({
        id: UserId,
        username: z.string(),
      }),
    ),
    count: z.number().int(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const query = new URLSearchParams();
    if (args.after !== undefined) query.set('after', args.after);
    if (args.limit !== undefined) query.set('limit', String(args.limit));
    const path = Routes.pollAnswerVoters(args.channel_id, args.message_id, args.answer_id);
    const r = (await container.rest.get(path, { query })) as RawVoters;
    const voters = r.users.map((u) => ({ id: u.id, username: u.username }));
    const wrapped = wrapUntrusted(JSON.stringify({ voters }), 'username');
    return dualResult({
      text: `${voters.length} voter(s) on answer ${args.answer_id}.`,
      data: { voters, count: voters.length, untrusted_text: wrapped },
    });
  },
});
