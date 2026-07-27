import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';

interface RawMember {
  user: { id: string; username: string };
  nick?: string | null;
}

export default defineTool({
  name: 'members_modify_current',
  category: 'members',
  description: [
    "**Purpose**: Modify the current bot user's own guild member entry (currently only `nick`).",
    '',
    '**When to use**:',
    "- Set/clear the bot's nickname in a guild without needing the MANAGE_NICKNAMES permission.",
    '',
    '**Returns**: `{nick}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to modify the bot member in'),
    nick: z.string().max(32).nullable().optional().describe('New nickname (null to clear)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    nick: z.string().nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.nick !== undefined) body.nick = args.nick;
    const m = (await container.rest.patch(Routes.guildMember(args.guild_id, '@me'), {
      body,
      reason: args.audit_reason,
    })) as RawMember;
    return dualResult({
      text: `Modified own member nick in guild \`${args.guild_id}\` → ${m.nick ?? '(cleared)'}.`,
      data: { nick: m.nick ?? null },
    });
  },
});
