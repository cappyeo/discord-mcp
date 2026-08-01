import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, GuildId } from '../_lib/snowflake.js';

interface RawCommandPerms {
  id: string;
  application_id: string;
  guild_id: string;
  permissions: Array<{ id: string; type: number; permission: boolean }>;
}

export default defineTool({
  name: 'commands_edit_command_permissions',
  category: 'commands',
  description: [
    '**Purpose**: Set per-command permission overrides for one command in a guild.',
    '',
    '**Auth**: This endpoint REQUIRES a user OAuth2 access token (`Bearer …`), NOT the bot token. The user must have permission to manage the guild AND access to the command. Pass the user access token via `bearer_token`.',
    '',
    '**Body**: `permissions` is an array of `{id, type, permission}` overrides where `type` is 1=ROLE, 2=USER, 3=CHANNEL.',
    '',
    '**Returns**: updated `{id, application_id, guild_id, permissions}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    guild_id: GuildId.describe('Guild scope'),
    command_id: z
      .string()
      .regex(/^\d{17,20}$/)
      .describe('Command ID to edit permissions for'),
    permissions: z
      .array(
        z.object({
          id: z.string().regex(/^\d{17,20}$/),
          type: z.number().int().min(1).max(3),
          permission: z.boolean(),
        }),
      )
      .max(100)
      .describe('Permission overrides - max 100 per command'),
    bearer_token: z
      .string()
      .min(1)
      .describe(
        'Required user OAuth2 access token (NOT bot token). Treated as a credential - do not log.',
      ),
  },
  outputSchema: {
    id: z.string(),
    application_id: z.string(),
    guild_id: z.string(),
    permissions: z.array(
      z.object({ id: z.string(), type: z.number().int(), permission: z.boolean() }),
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const bearer = args.bearer_token;
    if (bearer === undefined || bearer === '') {
      throw new Error(
        'commands_edit_command_permissions requires bearer_token (user OAuth2 access token, not bot token).',
      );
    }
    // Per Discord docs, the permissions edit endpoint requires Bearer auth.
    // Build a one-shot REST instance with the user token + Bearer prefix.
    const { REST } = await import('@discordjs/rest');
    // makeRequest cast: test config (msw) and runtime fetch have slightly different
    // signatures (undici vs undici-types). Bridge via unknown - runtime semantics are identical.
    const altRest = new REST({
      version: '10',
      authPrefix: 'Bearer',
      // biome-ignore lint/suspicious/noExplicitAny: REST's makeRequest signature differs across undici typings.
      makeRequest: fetch as any,
    }).setToken(bearer);
    const result = (await altRest.put(
      Routes.applicationCommandPermissions(args.application_id, args.guild_id, args.command_id),
      { body: { permissions: args.permissions } },
    )) as RawCommandPerms;
    return dualResult({
      text: `Updated permissions on command \`${result.id}\` (${result.permissions.length} override(s)).`,
      data: result,
    });
  },
});
