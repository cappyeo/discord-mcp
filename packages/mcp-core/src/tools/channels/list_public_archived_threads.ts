import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawThread {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  owner_id?: string;
  thread_metadata?: { archived?: boolean; archive_timestamp?: string };
}

interface RawArchivedList {
  threads: RawThread[];
  has_more?: boolean;
}

export default defineTool({
  name: 'channels_list_public_archived_threads',
  category: 'channels',
  description: [
    '**Purpose**: List archived public threads under a parent text/announcement channel.',
    '',
    '**When to use**:',
    '- Recover stale discussions; audit what was archived.',
    '',
    '**Pagination**: pass `before` (ISO 8601 timestamp from a prior `archive_timestamp`) and `limit` to page back further. `has_more` indicates more pages.',
    '',
    '**Returns**: `{threads:[{id,name,type,parent_id,owner_id,archive_timestamp}], has_more, count, channel_id}`. Structured names remain raw Discord data; the human-readable text response fences them.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Parent channel to list archived threads under'),
    before: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp — return threads archived before this'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (1-100)'),
  },
  outputSchema: {
    threads: z.array(
      z.object({
        id: ChannelId,
        name: z.string(),
        type: z.number().int(),
        parent_id: ChannelId.nullable(),
        owner_id: UserId.nullable(),
        archive_timestamp: z.string().nullable(),
      }),
    ),
    has_more: z.boolean(),
    count: z.number().int(),
    channel_id: ChannelId,
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
    if (args.before !== undefined) query.set('before', args.before);
    if (args.limit !== undefined) query.set('limit', String(args.limit));
    const raw = (await container.rest.get(
      Routes.channelThreads(args.channel_id, 'public'),
      query.size > 0 ? { query } : undefined,
    )) as RawArchivedList;
    const threads = raw.threads.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      parent_id: t.parent_id ?? null,
      owner_id: t.owner_id ?? null,
      archive_timestamp: t.thread_metadata?.archive_timestamp ?? null,
    }));
    const wrappedNames = wrapUntrusted(
      threads.map((t) => `[${t.id}] ${t.name}`).join('\n'),
      'message',
    );
    return dualResult({
      text: `**${threads.length} archived public thread(s)** under <#${args.channel_id}>:\n${wrappedNames}`,
      data: {
        threads,
        has_more: raw.has_more ?? false,
        count: threads.length,
        channel_id: args.channel_id,
      },
    });
  },
});
