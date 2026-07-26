import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';
import { CommandOption, commandBodyFields } from './_lib.js';

interface RawCommand {
  id: string;
  name: string;
  type: number;
}

const bulkCommandShape = z.object({
  name: commandBodyFields.name,
  name_localizations: commandBodyFields.name_localizations,
  description: commandBodyFields.description,
  description_localizations: commandBodyFields.description_localizations,
  options: z.array(CommandOption).optional(),
  default_member_permissions: commandBodyFields.default_member_permissions,
  dm_permission: commandBodyFields.dm_permission,
  default_permission: commandBodyFields.default_permission,
  type: commandBodyFields.type,
  nsfw: commandBodyFields.nsfw,
  integration_types: commandBodyFields.integration_types,
  contexts: commandBodyFields.contexts,
  handler: commandBodyFields.handler,
});

export default defineTool({
  name: 'commands_bulk_overwrite_guild',
  category: 'commands',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Atomically REPLACE the guild-scoped command registry. Any commands not in `commands` are deleted from this guild. An EMPTY array deletes every command in this guild.',
    '',
    '**Caution**: this is a wholesale replace — call `commands_list_guild` first to confirm scope.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually apply the replace.',
    '',
    '**Returns**: `{commands:[{id, name, type}], count}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
    commands: z
      .array(bulkCommandShape)
      .describe(
        'Full set of commands to register in this guild (REPLACES the existing registry; an empty array deletes every command).',
      ),
  },
  outputSchema: {
    commands: z.array(z.object({ id: z.string(), name: z.string(), type: z.number().int() })),
    count: z.number(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.put(
      Routes.applicationGuildCommands(args.application_id, args.guild_id),
      { body: args.commands },
    )) as RawCommand[];
    const cmds = raw.map((c) => ({ id: c.id, name: c.name, type: c.type }));
    return dualResult({
      text: `Bulk-overwrote guild \`${args.guild_id}\` registry: **${cmds.length} command(s)**.`,
      data: { commands: cmds, count: cmds.length },
    });
  },
});
