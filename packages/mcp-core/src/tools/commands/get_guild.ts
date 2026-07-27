import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawCommand {
  id: string;
  application_id: string;
  // Optional on APIApplicationCommand.
  guild_id?: string;
  name: string;
  description: string;
  type: number;
}

export default defineTool({
  name: 'commands_get_guild',
  category: 'commands',
  description:
    '**Purpose**: Fetch one guild-scoped command by id.\n\n**Returns**: `{id, name, description, type, application_id, guild_id, untrusted_text}`.',
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID (snowflake)'),
  },
  outputSchema: {
    id: z.string(),
    application_id: z.string(),
    guild_id: z.string(),
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
      Routes.applicationGuildCommand(args.application_id, args.guild_id, args.command_id),
    )) as RawCommand;
    const wrapped = wrapUntrusted(
      JSON.stringify({ name: c.name, description: c.description }),
      'channel_topic',
    );
    return dualResult({
      text: `Guild command \`/${c.name}\` (\`cmd:${c.id}\`).`,
      data: {
        id: c.id,
        application_id: c.application_id,
        guild_id: c.guild_id ?? args.guild_id,
        name: c.name,
        description: c.description,
        type: c.type,
        untrusted_text: wrapped,
      },
    });
  },
});
