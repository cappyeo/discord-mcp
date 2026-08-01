import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'commands_delete_guild',
  category: 'commands',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a guild-scoped command. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**Returns**: `{deleted, command_id, guild_id}`. Pass `__confirm:true` AND `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID to delete'),
  },
  outputSchema: {
    deleted: z.literal(true),
    command_id: z.string(),
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(
      Routes.applicationGuildCommand(args.application_id, args.guild_id, args.command_id),
    );
    return dualResult({
      text: `Deleted guild command \`${args.command_id}\` from guild \`${args.guild_id}\`.`,
      data: {
        deleted: true as const,
        command_id: args.command_id,
        guild_id: args.guild_id,
      },
    });
  },
});
