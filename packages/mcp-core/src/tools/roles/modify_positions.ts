import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId } from '../_lib/snowflake.js';

interface RawRole {
  id: string;
  name: string;
  position: number;
}

export default defineTool({
  name: 'roles_modify_positions',
  category: 'roles',
  description: [
    '**Purpose**: Bulk-reorder guild roles via `PATCH /guilds/{guild.id}/roles`.',
    '',
    '**When to use**:',
    '- Move several roles in one transaction (e.g. swap two adjacent roles).',
    '',
    '**Body**: array of `{id, position?}`. Discord renumbers other roles automatically to make room.',
    '',
    '**Returns**: `{roles:[{id, name, position}], count}` - full role list after the change.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the roles'),
    positions: z
      .array(
        z.object({
          id: RoleId,
          position: z.number().int().min(0).optional(),
        }),
      )
      .min(1)
      .describe('Roles whose position changes (other roles are auto-renumbered)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    roles: z.array(
      z.object({
        id: RoleId,
        name: z.string(),
        position: z.number().int(),
      }),
    ),
    count: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const raw = (await container.rest.patch(Routes.guildRoles(args.guild_id), {
      body: args.positions,
      reason: args.audit_reason,
    })) as RawRole[];
    const roles = raw.map((r) => ({ id: r.id, name: r.name, position: r.position }));
    return dualResult({
      text: `Reordered ${args.positions.length} role(s); guild now has ${roles.length} role(s).`,
      data: { roles, count: roles.length },
    });
  },
});
