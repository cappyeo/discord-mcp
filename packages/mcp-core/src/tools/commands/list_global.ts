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
  name: 'commands_list_global',
  category: 'commands',
  description:
    '**Purpose**: List globally-registered application commands.\n\n**When to use**: audit global slash commands; before bulk-overwriting global registry.\n\n**Returns**: `{commands:[{id, name, description, type}], count, untrusted_text}`. Names and descriptions remain raw app-author data; `untrusted_text` provides a separately fenced copy.',
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    with_localizations: z
      .boolean()
      .optional()
      .describe('Include name_localizations / description_localizations objects in the response'),
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
    const query = new URLSearchParams();
    if (args.with_localizations !== undefined)
      query.set('with_localizations', String(args.with_localizations));
    const raw = (await container.rest.get(Routes.applicationCommands(args.application_id), {
      query,
    })) as RawCommand[];
    const cmds = raw.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      type: c.type,
    }));
    const wrapped = wrapUntrusted(
      JSON.stringify(cmds.map((c) => ({ name: c.name, description: c.description }))),
      'channel_topic',
    );
    return dualResult({
      text:
        `**${cmds.length} global command(s)**:\n` +
        cmds.map((c) => `- /${c.name} (\`cmd:${c.id}\`)`).join('\n'),
      data: { commands: cmds, count: cmds.length, untrusted_text: wrapped },
    });
  },
});
