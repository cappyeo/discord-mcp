import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, RoleId, UserId } from '../_lib/snowflake.js';

interface RawMember {
  user: { id: string; username: string };
  nick?: string | null;
  roles: string[];
}

export default defineTool({
  name: 'members_modify',
  category: 'members',
  description: [
    "**Purpose**: Modify a guild member's nick, roles, voice state, or timeout. One tool covers the full PATCH /guilds/{guild.id}/members/{user.id} surface.",
    '',
    '**When to use**:',
    '- Set/clear nickname (`nick`).',
    '- Replace role set wholesale (`roles`). To add/remove a single role, prefer `members_add_role` / `members_remove_role`.',
    '- Server mute/deaf in voice (`mute`, `deaf`).',
    '- Move user between voice channels (`channel_id`).',
    '- Apply a timeout (`communication_disabled_until`, ISO-8601 timestamp).',
    '- Adjust member flags bitfield (`flags`).',
    '',
    '**Pass only the fields you want to change.** Discord ignores undefined fields.',
    '',
    '**Returns**: `{user_id, nick, roles}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the member'),
    user_id: UserId.describe('Member to modify'),
    nick: z.string().max(32).nullable().optional().describe('Nickname (null to clear)'),
    roles: z.array(RoleId).optional().describe('Replace role set wholesale'),
    mute: z.boolean().optional().describe('Server-mute in voice'),
    deaf: z.boolean().optional().describe('Server-deafen in voice'),
    channel_id: ChannelId.nullable()
      .optional()
      .describe('Voice channel to move to (null to disconnect)'),
    communication_disabled_until: z
      .string()
      .nullable()
      .optional()
      .describe('ISO-8601 timestamp ending the timeout (null to clear, max 28 days from now)'),
    flags: z.number().int().optional().describe('Member flags bitfield'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    user_id: UserId,
    nick: z.string().nullable(),
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
    const passthrough = [
      'nick',
      'roles',
      'mute',
      'deaf',
      'channel_id',
      'communication_disabled_until',
      'flags',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const m = (await container.rest.patch(Routes.guildMember(args.guild_id, args.user_id), {
      body,
      reason: args.audit_reason,
    })) as RawMember;
    return dualResult({
      text: `Modified member \`${m.user.id}\` in guild \`${args.guild_id}\`.`,
      data: { user_id: m.user.id, nick: m.nick ?? null, roles: m.roles },
    });
  },
});
