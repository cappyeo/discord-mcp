import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId, UserId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'members_add_role',
  category: 'members',
  description: [
    '**Purpose**: Add a single role to a guild member.',
    '',
    '**When to use**:',
    '- Targeted role grant (e.g. give @verified to a single user).',
    '',
    '**When NOT to use**:',
    '- Replacing the entire role set → use `members_modify` with `roles`.',
    '',
    '**Returns**: `{added, user_id, role_id}`. Idempotent - re-adding is a no-op.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the member'),
    user_id: UserId.describe('Member to grant the role to'),
    role_id: RoleId.describe('Role to add'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    added: z.literal(true),
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
    await container.rest.put(Routes.guildMemberRole(args.guild_id, args.user_id, args.role_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Added role \`${args.role_id}\` to user \`${args.user_id}\` in guild \`${args.guild_id}\`.`,
      data: { added: true as const, user_id: args.user_id, role_id: args.role_id },
    });
  },
});
