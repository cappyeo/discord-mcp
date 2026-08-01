import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

interface BulkBanResp {
  banned_users: string[];
  failed_users: string[];
}

export default defineTool({
  name: 'members_bulk_ban',
  category: 'members',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Ban many users at once (1-200 per call). **DESTRUCTIVE - IRREVERSIBLE without manual unban.**',
    '',
    '**When to use**:',
    '- Mass moderation (raid response).',
    '',
    '**When NOT to use**:',
    '- Single user → use `members_ban`.',
    '',
    '**Returns**: `{banned_users:[...], failed_users:[...], banned_count, failed_count}`. Discord returns 200 with both arrays even on partial failure.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually bulk-ban.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to ban from'),
    user_ids: z.array(UserId).min(1).max(200).describe('Users to ban (1-200 per call)'),
    delete_message_seconds: z
      .number()
      .int()
      .min(0)
      .max(604800)
      .optional()
      .describe("Delete each user's messages from the last N seconds (0..604800 = up to 7 days)"),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    banned_users: z.array(UserId),
    failed_users: z.array(UserId),
    banned_count: z.number().int(),
    failed_count: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { user_ids: args.user_ids };
    if (args.delete_message_seconds !== undefined)
      body.delete_message_seconds = args.delete_message_seconds;
    const resp = (await container.rest.post(Routes.guildBulkBan(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as BulkBanResp;
    return dualResult({
      text: `Bulk-ban complete: ${resp.banned_users.length} banned, ${resp.failed_users.length} failed.`,
      data: {
        banned_users: resp.banned_users,
        failed_users: resp.failed_users,
        banned_count: resp.banned_users.length,
        failed_count: resp.failed_users.length,
      },
    });
  },
});
