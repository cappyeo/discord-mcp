import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawCommand {
  id: string;
  application_id: string;
  name: string;
  description: string;
  type: number;
}

export default defineTool({
  name: 'commands_get_global',
  category: 'commands',
  description:
    '**Purpose**: Fetch one global application command by id.\n\n**Returns**: `{id, name, description, type, application_id, untrusted_text}`. `name` and `description` remain raw; `untrusted_text` provides a separately fenced copy.',
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID (snowflake)'),
  },
  outputSchema: {
    id: z.string(),
    application_id: z.string(),
    name: z.string(),
    description: z.string(),
    type: z.number().int(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const c = (await container.rest.get(
      Routes.applicationCommand(args.application_id, args.command_id),
    )) as RawCommand;
    const wrapped = wrapUntrusted(
      JSON.stringify({ name: c.name, description: c.description }),
      'channel_topic',
    );
    return dualResult({
      text: `Command \`/${c.name}\` (\`cmd:${c.id}\`, type=${c.type}).`,
      data: {
        id: c.id,
        application_id: c.application_id,
        name: c.name,
        description: c.description,
        type: c.type,
        untrusted_text: wrapped,
      },
    });
  },
});
