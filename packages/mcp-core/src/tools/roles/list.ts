import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { GUILD_READ_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, RoleId } from '../_lib/snowflake.js';

interface RawRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  mentionable: boolean;
  hoist: boolean;
  managed: boolean;
}

export default defineTool({
  name: 'roles_list',
  category: 'roles',
  access: GUILD_READ_ACCESS,
  description:
    '**Purpose**: List all roles in a guild.\n\n**When to use**: discover role IDs, audit hierarchy + permissions.\n\n**Example**: `{guild_id:"999000999000999000"}`\n\n**Returns**: `{roles:[{id,name,color,position,permissions,mentionable,hoist,managed}], count}`.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to list roles for'),
  },
  outputSchema: {
    roles: z.array(
      z.object({
        id: RoleId,
        name: z.string(),
        color: z.number().int(),
        position: z.number().int(),
        permissions: z.string(),
        mentionable: z.boolean(),
        hoist: z.boolean(),
        managed: z.boolean(),
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
    const raw = (await container.rest.get(Routes.guildRoles(args.guild_id))) as RawRole[];
    return dualResult({
      text:
        `Found ${raw.length} role(s):\n` +
        raw
          .map(
            (r) =>
              `- **${r.name}** (\`role:${r.id}\`, color #${r.color.toString(16).padStart(6, '0')}, pos ${r.position})`,
          )
          .join('\n'),
      data: { roles: raw, count: raw.length },
    });
  },
});
