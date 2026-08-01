import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'commands_delete_global',
  category: 'commands',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a global application command. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**Effect**: removes the command from every guild within ~1 hour of propagation.',
    '',
    '**Returns**: `{deleted, command_id}`. Pass `__confirm:true` AND `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID to delete'),
  },
  outputSchema: {
    deleted: z.literal(true),
    command_id: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.applicationCommand(args.application_id, args.command_id));
    return dualResult({
      text: `Deleted global command \`${args.command_id}\`.`,
      data: { deleted: true as const, command_id: args.command_id },
    });
  },
});
