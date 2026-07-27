import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { UserId } from '../_lib/snowflake.js';

interface RawUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  // Optional on APIUser — omitted (not null) when the account has no banner.
  banner?: string | null;
  bot?: boolean;
}

export default defineTool({
  name: 'users_modify_current',
  category: 'users',
  description: [
    '**Purpose**: Update the authenticated bot/user profile (`PATCH /users/@me`).',
    '',
    '**When to use**:',
    '- Rename the bot, change avatar/banner.',
    '',
    '**Note**: User-scoped endpoint — does NOT accept `audit_reason`.',
    '',
    '**Returns**: projected user shape `{id, username, global_name, avatar, banner}`.',
  ].join('\n'),
  inputSchema: {
    username: z.string().min(2).max(32).optional().describe('New username (2-32 chars)'),
    avatar: z
      .string()
      .nullable()
      .optional()
      .describe('Avatar as base64 image data URI, or null to clear'),
    banner: z
      .string()
      .nullable()
      .optional()
      .describe('Banner as base64 image data URI, or null to clear'),
  },
  outputSchema: {
    id: UserId,
    username: z.string(),
    global_name: z.string().nullable(),
    avatar: z.string().nullable(),
    banner: z.string().nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.username !== undefined) body.username = args.username;
    if (args.avatar !== undefined) body.avatar = args.avatar;
    if (args.banner !== undefined) body.banner = args.banner;
    const u = (await container.rest.patch(Routes.user('@me'), { body })) as RawUser;
    return dualResult({
      text: `Updated \`@me\` profile (id=${u.id}).`,
      data: {
        id: u.id,
        username: u.username,
        global_name: u.global_name,
        avatar: u.avatar,
        banner: u.banner ?? null,
      },
    });
  },
});
