import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import type { z } from 'zod';
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

export default defineTool({
  name: 'commands_create_global',
  category: 'commands',
  description: [
    '**Purpose**: Create or upsert a global application command. Global commands propagate within ~1 hour.',
    '',
    '**Body**: standard command shape - `name` is required. `description` is required for CHAT_INPUT (type=1) but optional for USER (2) / MESSAGE (3) commands.',
    '',
    '**Idempotent**: posting the same `name`+`type` updates the existing command (Discord upsert semantics).',
    '',
    '**Returns**: `{id, name, description, type, application_id}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    ...commandBodyFields,
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
    const cmd = (await container.rest.post(Routes.applicationCommands(args.application_id), {
      body,
    })) as RawCommand;
    const out: Record<string, unknown> = {
      id: cmd.id,
      application_id: cmd.application_id,
      name: cmd.name,
      type: cmd.type,
    };
    if (cmd.description !== undefined) out.description = cmd.description;
    return dualResult({
      text: `Created global command \`/${cmd.name}\` (\`cmd:${cmd.id}\`).`,
      data: out as z.infer<z.ZodObject<typeof commandOutputShape>>,
    });
  },
});
