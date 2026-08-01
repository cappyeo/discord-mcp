import { z } from 'zod';
import { PermissionString } from '../_lib/permissions.js';

/**
 * Discord application command option (recursive - `options` may nest sub-options
 * for SUB_COMMAND / SUB_COMMAND_GROUP types).
 *
 * Type values (APPLICATION_COMMAND_OPTION_TYPE):
 *   1=SUB_COMMAND, 2=SUB_COMMAND_GROUP, 3=STRING, 4=INTEGER, 5=BOOLEAN,
 *   6=USER, 7=CHANNEL, 8=ROLE, 9=MENTIONABLE, 10=NUMBER, 11=ATTACHMENT.
 */
// biome-ignore lint/suspicious/noExplicitAny: zod recursive schemas require an unconstrained lazy type.
export const CommandOption: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.number().int().min(1).max(11),
    name: z.string().min(1).max(32),
    name_localizations: z.record(z.string(), z.string()).optional().nullable(),
    description: z.string().min(1).max(100),
    description_localizations: z.record(z.string(), z.string()).optional().nullable(),
    required: z.boolean().optional(),
    choices: z
      .array(
        z.object({
          name: z.string(),
          name_localizations: z.record(z.string(), z.string()).optional().nullable(),
          value: z.union([z.string(), z.number()]),
        }),
      )
      .optional(),
    options: z.array(CommandOption).optional(),
    channel_types: z.array(z.number()).optional(),
    min_value: z.number().optional(),
    max_value: z.number().optional(),
    min_length: z.number().optional(),
    max_length: z.number().optional(),
    autocomplete: z.boolean().optional(),
  }),
);

/**
 * Shared per-key fields used to build create/modify command schemas. These are
 * raw zod entries - spread them into a defineTool `inputSchema` and add
 * any IDs (application_id, guild_id, command_id) at the call site.
 *
 * For modify, callers should wrap each entry's value in `.optional()` if not
 * already optional (factored helpers below do this).
 */
export const commandBodyFields = {
  name: z.string().min(1).max(32),
  name_localizations: z.record(z.string(), z.string()).optional().nullable(),
  description: z.string().max(100).optional(),
  description_localizations: z.record(z.string(), z.string()).optional().nullable(),
  options: z.array(CommandOption).optional(),
  default_member_permissions: PermissionString.optional().nullable(),
  dm_permission: z.boolean().optional().nullable(),
  default_permission: z.boolean().optional().nullable(),
  type: z.number().int().min(1).max(4).optional(),
  nsfw: z.boolean().optional(),
  integration_types: z.array(z.number()).optional(),
  contexts: z.array(z.number()).optional(),
  handler: z.number().optional(),
} as const;

/** Body keys to passthrough from validated args into the REST request body. */
export const commandBodyKeys = [
  'name',
  'name_localizations',
  'description',
  'description_localizations',
  'options',
  'default_member_permissions',
  'dm_permission',
  'default_permission',
  'type',
  'nsfw',
  'integration_types',
  'contexts',
  'handler',
] as const;

/** Build a body object containing only the present (non-undefined) command fields. */
export function pickCommandBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of commandBodyKeys) {
    const v = args[key];
    if (v !== undefined) body[key] = v;
  }
  return body;
}

/** Output schema for a projected command (id + name + description + type). */
export const commandOutputShape = {
  id: z.string(),
  application_id: z.string().optional(),
  guild_id: z.string().optional().nullable(),
  name: z.string(),
  description: z.string().optional(),
  type: z.number().int(),
};
