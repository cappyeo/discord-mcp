import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawEntry {
  id: string;
  target_id: string | null;
  user_id: string | null;
  action_type: number;
  reason?: string;
}

interface RawAuditLog {
  audit_log_entries: RawEntry[];
}

export default defineTool({
  name: 'audit_log_get',
  category: 'audit_log',
  description:
    '**Purpose**: Fetch audit log entries for a guild.\n\n**When to use**: investigate "who kicked X?", post-incident forensics.\n\n**Example**: `{guild_id:"999000999000999000", limit:50, action_type:20}`  (action_type 20 = MEMBER_KICK)\n\n**Returns**: `{entries:[{id, target_id, user_id, action_type, reason}], count}`. Structured `reason` values remain raw moderator-controlled data; the human-readable text response fences them.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
    limit: z.number().int().min(1).max(100).default(50).describe('Max entries (1-100, default 50)'),
    action_type: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Filter by Discord audit action type'),
    user_id: UserId.optional().describe('Filter to entries triggered by this user'),
  },
  outputSchema: {
    entries: z.array(
      z.object({
        id: z.string(),
        target_id: z.string().nullable(),
        user_id: UserId.nullable(),
        action_type: z.number().int(),
        reason: z.string().optional(),
      }),
    ),
    count: z.number(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const query = new URLSearchParams({ limit: String(args.limit) });
    if (args.action_type !== undefined) query.set('action_type', String(args.action_type));
    if (args.user_id !== undefined) query.set('user_id', args.user_id);
    const raw = (await container.rest.get(Routes.guildAuditLog(args.guild_id), {
      query,
    })) as RawAuditLog;
    const entries = raw.audit_log_entries.map((e) => {
      const result: Record<string, unknown> = {
        id: e.id,
        target_id: e.target_id,
        user_id: e.user_id,
        action_type: e.action_type,
      };
      if (e.reason !== undefined) result.reason = e.reason;
      return result;
    });
    const lines = entries.map((e) => {
      const reasonStr =
        e.reason !== undefined ? wrapUntrusted(String(e.reason), 'audit_reason') : '';
      return `- entry ${e.id}: action ${e.action_type}, mod \`user:${e.user_id ?? '?'}\` → target \`${e.target_id ?? '?'}\` ${reasonStr}`;
    });
    return dualResult({
      text: `**${entries.length} audit log entr${entries.length === 1 ? 'y' : 'ies'}**:\n${lines.join('\n')}`,
      data: { entries, count: entries.length },
    });
  },
});
