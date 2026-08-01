import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'members_ban',
  category: 'members',
  preconditions: ['confirm_required'] as const,
  description: [
    "**Purpose**: Ban a user from a guild. **DESTRUCTIVE - user can't rejoin until unbanned.**",
    '',
    '**When to use**:',
    '- Permanent removal of a malicious user.',
    '',
    '**When NOT to use**:',
    '- Soft-removal → use `members_kick`.',
    '- Multiple users → use `members_bulk_ban`.',
    '',
    "**Optional `delete_message_seconds`** (0..604800) deletes that user's recent messages.",
    '',
    '**Returns**: `{banned, user_id, guild_id}`. Idempotent - re-banning is a no-op.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually ban.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to ban from'),
    user_id: UserId.describe('Member to ban'),
    delete_message_seconds: z
      .number()
      .int()
      .min(0)
      .max(604800)
      .optional()
      .describe("Delete the user's messages from the last N seconds (0..604800 = up to 7 days)"),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    banned: z.literal(true),
    user_id: UserId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.delete_message_seconds !== undefined)
      body.delete_message_seconds = args.delete_message_seconds;
    await container.rest.put(Routes.guildBan(args.guild_id, args.user_id), {
      body,
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Banned user \`${args.user_id}\` from guild \`${args.guild_id}\`.`,
      data: { banned: true as const, user_id: args.user_id, guild_id: args.guild_id },
    });
  },
});
