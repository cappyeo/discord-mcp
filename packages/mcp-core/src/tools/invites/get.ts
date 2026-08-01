import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, InviteCode, ScheduledEventId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawInvite {
  code: string;
  type?: number;
  guild?: { id: string; name: string; description?: string | null };
  channel: { id: string; name: string | null; type: number } | null;
  inviter?: { id: string; username: string; global_name?: string | null };
  target_type?: number;
  approximate_presence_count?: number;
  approximate_member_count?: number;
  expires_at?: string | null;
  guild_scheduled_event?: { id: string; name: string };
}

export default defineTool({
  name: 'invites_get',
  category: 'invites',
  description: [
    '**Purpose**: Look up a Discord invite by its code (or full URL after stripping the prefix).',
    '',
    '**When to use**:',
    '- Inspect an invite before deleting or sharing.',
    '- Resolve which guild/channel an invite points at.',
    '',
    '**When NOT to use**:',
    '- Listing all invites for a channel → use `invites_list_channel`.',
    '',
    '**Example**: `{code:"abc123def", with_counts:true}`',
    '',
    '**Returns**: Projected invite shape with optional counts. Guild and channel names remain raw Discord data; `untrusted_names` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    code: InviteCode.describe('Invite code (the bit after https://discord.gg/)'),
    with_counts: z.boolean().optional().describe('Include approximate member/presence counts'),
    with_expiration: z.boolean().optional().describe('Include expires_at field'),
    guild_scheduled_event_id: ScheduledEventId.optional().describe(
      'Surface a specific scheduled event tied to the invite',
    ),
  },
  outputSchema: {
    code: InviteCode,
    channel_id: ChannelId.nullable(),
    guild_id: GuildId.optional(),
    inviter_id: UserId.optional(),
    inviter_name: z.string().optional(),
    expires_at: z.string().nullable().optional(),
    approximate_member_count: z.number().optional(),
    approximate_presence_count: z.number().optional(),
    untrusted_names: z.string(),
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
    if (args.with_counts !== undefined) query.set('with_counts', String(args.with_counts));
    if (args.with_expiration !== undefined)
      query.set('with_expiration', String(args.with_expiration));
    if (args.guild_scheduled_event_id !== undefined)
      query.set('guild_scheduled_event_id', args.guild_scheduled_event_id);
    const inv = (await container.rest.get(Routes.invite(args.code), {
      query,
    })) as RawInvite;
    const names = wrapUntrusted(
      JSON.stringify({
        guild_name: inv.guild?.name ?? null,
        channel_name: inv.channel?.name ?? null,
        inviter_username: inv.inviter?.global_name ?? inv.inviter?.username ?? null,
      }),
      'channel_topic',
    );
    return dualResult({
      text: `Invite \`${inv.code}\` → guild=${inv.guild?.id ?? 'group_dm'} channel=${inv.channel?.id ?? 'unknown'}.`,
      data: {
        code: inv.code,
        channel_id: inv.channel?.id ?? null,
        guild_id: inv.guild?.id,
        inviter_id: inv.inviter?.id,
        inviter_name: inv.inviter?.global_name ?? inv.inviter?.username,
        expires_at: inv.expires_at,
        approximate_member_count: inv.approximate_member_count,
        approximate_presence_count: inv.approximate_presence_count,
        untrusted_names: names,
      },
    });
  },
});
