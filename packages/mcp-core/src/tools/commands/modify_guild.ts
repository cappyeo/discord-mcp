import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { withAttributionField } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';
import { commandBodyFields, commandOutputShape, pickCommandBody } from './_lib.js';

interface RawCommand {
  id: string;
  application_id: string;
  guild_id: string;
  name: string;
  description?: string;
  type: number;
}

const modifyFields = {
  ...commandBodyFields,
  name: commandBodyFields.name.optional(),
} as const;

export default defineTool({
  name: 'commands_modify_guild',
  category: 'commands',
  description: [
    '**Purpose**: Edit a guild-scoped command. All command-body fields are optional.',
    '',
    '**Returns**: updated `{id, name, description, type, application_id, guild_id}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
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
  handler: async (args, ctx) => {
    const body = pickCommandBody(args as unknown as Record<string, unknown>);
    if (typeof body.description === 'string')
      body.description = withAttributionField(body.description, ctx.caller, 'Updated', 100);
    const cmd = (await container.rest.patch(
      Routes.applicationGuildCommand(args.application_id, args.guild_id, args.command_id),
      { body },
    )) as RawCommand;
    const out: Record<string, unknown> = {
      id: cmd.id,
      application_id: cmd.application_id,
      guild_id: cmd.guild_id,
      name: cmd.name,
      type: cmd.type,
    };
    if (cmd.description !== undefined) out.description = cmd.description;
    return dualResult({
      text: `Modified guild command \`/${cmd.name}\` (\`cmd:${cmd.id}\`).`,
      data: out as z.infer<z.ZodObject<typeof commandOutputShape>>,
    });
  },
});
