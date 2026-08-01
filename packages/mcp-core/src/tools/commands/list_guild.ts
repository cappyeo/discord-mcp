import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';

interface RawCommand {
  id: string;
  application_id: string;
  guild_id: string;
  name: string;
  description: string;
  type: number;
}

export default defineTool({
  name: 'commands_list_guild',
  category: 'commands',
  description:
    '**Purpose**: List slash commands registered for a specific guild.\n\n**When to use**: audit which commands are registered; before bulk-overwriting.\n\n**Returns**: `{commands:[{id, name, description, type}], count}`.',
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
  },
  outputSchema: {
    commands: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        type: z.number().int(),
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
    const raw = (await container.rest.get(
      Routes.applicationGuildCommands(args.application_id, args.guild_id),
    )) as RawCommand[];
    const cmds = raw.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      type: c.type,
    }));
    return dualResult({
      text:
        `**${cmds.length} command(s)**:\n` +
        cmds.map((c) => `- /${c.name} - ${c.description} (\`cmd:${c.id}\`)`).join('\n'),
      data: { commands: cmds, count: cmds.length },
    });
  },
});
