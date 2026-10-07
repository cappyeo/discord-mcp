import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId, UserId } from '../_lib/snowflake.js';

const UserIds = z
  .array(UserId)
  .min(1)
  .max(100)
  .refine((userIds) => new Set(userIds).size === userIds.length, {
    message: 'User IDs must be unique.',
  });

export default defineTool({
  name: 'members_bulk_add_role',
  category: 'members',
  description: [
    '**Purpose**: Add one role to 1-100 explicitly identified guild members.',
    '',
    '**When to use**:',
    '- Assign the same existing role to a bounded list of known members.',
    '',
    '**When NOT to use**:',
    '- Assigning a role to one member -> use `members_add_role`.',
    '- Discovering or filtering members -> use `members_list` first.',
    '',
    '**Returns**: `{role_id, succeeded_user_ids, failed_user_ids, succeeded_count, failed_count}`. Each successful PUT includes an idempotent no-op when the member already has the role.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the members'),
    role_id: RoleId.describe('Role to add'),
    user_ids: UserIds.describe('Unique member IDs to grant the role to (1-100)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    role_id: RoleId,
    succeeded_user_ids: z.array(UserId),
    failed_user_ids: z.array(UserId),
    succeeded_count: z.number().int(),
    failed_count: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const succeededUserIds: string[] = [];
    const failedUserIds: string[] = [];

    ctx.signal.throwIfAborted();
    for (const userId of args.user_ids) {
      ctx.signal.throwIfAborted();
      try {
        await container.rest.put(Routes.guildMemberRole(args.guild_id, userId, args.role_id), {
          reason: args.audit_reason,
          signal: ctx.signal,
        });
        succeededUserIds.push(userId);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        failedUserIds.push(userId);
      }
    }

    return dualResult({
      text: `Bulk role assignment complete: ${succeededUserIds.length} successful (including idempotent no-ops), ${failedUserIds.length} failed.`,
      data: {
        role_id: args.role_id,
        succeeded_user_ids: succeededUserIds,
        failed_user_ids: failedUserIds,
        succeeded_count: succeededUserIds.length,
        failed_count: failedUserIds.length,
      },
    });
  },
});
