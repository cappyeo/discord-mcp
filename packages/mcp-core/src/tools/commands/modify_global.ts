import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';
import { commandBodyFields, commandOutputShape, pickCommandBody } from './_lib.js';

interface RawCommand {
  id: string;
  application_id: string;
  name: string;
  description?: string;
  type: number;
}

// All create-fields are optional for modify; we wrap each entry with `.optional()`.
// `name` is the only field that's NOT already optional in commandBodyFields.
const modifyFields = {
  ...commandBodyFields,
  name: commandBodyFields.name.optional(),
} as const;

export default defineTool({
  name: 'commands_modify_global',
  category: 'commands',
  description: [
    '**Purpose**: Edit a global application command. All command-body fields are optional - pass only what changes.',
    '',
    '**Returns**: updated `{id, name, description, type, application_id}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID to modify'),
    ...modifyFields,
  },
  outputSchema: commandOutputShape,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body = pickCommandBody(args as unknown as Record<string, unknown>);
    const cmd = (await container.rest.patch(
      Routes.applicationCommand(args.application_id, args.command_id),
      { body },
    )) as RawCommand;
    const out: Record<string, unknown> = {
      id: cmd.id,
      application_id: cmd.application_id,
      name: cmd.name,
      type: cmd.type,
    };
    if (cmd.description !== undefined) out.description = cmd.description;
    return dualResult({
      text: `Modified global command \`/${cmd.name}\` (\`cmd:${cmd.id}\`).`,
      data: out as z.infer<z.ZodObject<typeof commandOutputShape>>,
    });
  },
});
