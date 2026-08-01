import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { EmojiId, GuildId, RoleId } from '../_lib/snowflake.js';

interface RawEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
  roles?: string[];
}

export default defineTool({
  name: 'emojis_modify',
  category: 'emojis',
  description: [
    "**Purpose**: Update a guild emoji's name and/or role restrictions.",
    '',
    '**When to use**:',
    '- Rename an emoji; restrict to a role tier.',
    '',
    '**When NOT to use**:',
    '- Replacing the image - Discord does not allow editing emoji bytes; create a new one and delete the old.',
    '',
    '**Returns**: `{id, name, animated, roles}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild owning the emoji'),
    emoji_id: EmojiId.describe('Emoji to modify'),
    name: z.string().min(2).max(32).optional().describe('New name (2-32 chars)'),
    roles: z.array(RoleId).optional().describe('Replacement role list (empty array = everyone)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: EmojiId.nullable(),
    name: z.string().nullable(),
    animated: z.boolean(),
    roles: z.array(RoleId),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.roles !== undefined) body.roles = args.roles;
    const e = (await container.rest.patch(Routes.guildEmoji(args.guild_id, args.emoji_id), {
      body,
      reason: args.audit_reason,
    })) as RawEmoji;
    return dualResult({
      text: `Modified emoji ${e.name ?? '(unnamed)'} (\`${e.id ?? 'null'}\`).`,
      data: {
        id: e.id,
        name: e.name,
        animated: e.animated ?? false,
        roles: e.roles ?? [],
      },
    });
  },
});
