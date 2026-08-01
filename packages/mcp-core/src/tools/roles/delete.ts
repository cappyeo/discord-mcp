import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'roles_delete',
  category: 'roles',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a role from a guild. **DESTRUCTIVE - IRREVERSIBLE.** All members holding this role lose it.',
    '',
    '**When to use**:',
    '- Tear down deprecated/integration roles.',
    '',
    '**When NOT to use**:',
    '- Just removing the role from a single user → use `members_remove_role`.',
    '',
    '**Returns**: `{deleted, role_id, guild_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the role'),
    role_id: RoleId.describe('Role to delete (IRREVERSIBLE)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    role_id: RoleId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildRole(args.guild_id, args.role_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted role \`${args.role_id}\` from guild \`${args.guild_id}\`.`,
      data: { deleted: true as const, role_id: args.role_id, guild_id: args.guild_id },
    });
  },
});
