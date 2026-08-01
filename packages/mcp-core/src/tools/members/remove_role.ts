import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'members_remove_role',
  category: 'members',
  description: [
    '**Purpose**: Remove a single role from a guild member.',
    '',
    '**When to use**:',
    '- Targeted role revocation (e.g. revoke @verified).',
    '',
    '**When NOT to use**:',
    '- Replacing the entire role set → use `members_modify` with `roles`.',
    '',
    '**Returns**: `{removed, user_id, role_id}`. Idempotent - removing a role the user does not have is a no-op.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the member'),
    user_id: UserId.describe('Member to revoke the role from'),
    role_id: RoleId.describe('Role to remove'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    removed: z.literal(true),
    user_id: UserId,
    role_id: RoleId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildMemberRole(args.guild_id, args.user_id, args.role_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Removed role \`${args.role_id}\` from user \`${args.user_id}\` in guild \`${args.guild_id}\`.`,
      data: { removed: true as const, user_id: args.user_id, role_id: args.role_id },
    });
  },
});
