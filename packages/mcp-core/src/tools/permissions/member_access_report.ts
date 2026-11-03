import { container } from '@sapphire/pieces';
import { ChannelType, PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { filterCallerVisibleChannels } from '../_lib/caller-visibility.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import {
  applyPermissionBits,
  combineRoleOverwriteBits,
  indexPermissionOverwrites,
  type RawChannel,
  type RawRole,
} from './_lib/evaluator.js';

const PermissionState = z.enum(['allowed', 'denied', 'unknown']);
export default defineTool({
  name: 'permissions_member_access_report',
  category: 'permissions',
  description: [
    '**Purpose**: Report one member’s effective view/send/manage access across a bounded set of guild channels.',
    '',
    '**Safety**: Read-only. It reuses Discord role and overwrite semantics, preserves unknown results for incomplete payloads, and does not infer access for ambiguous threads.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to inspect'),
    user_id: UserId.describe('Member whose perspective is evaluated'),
    channel_ids: z
      .array(z.string().regex(/^\d{17,20}$/))
      .max(100)
      .optional()
      .describe('Optional bounded channel selection; omit for all returned guild channels'),
  },
  outputSchema: {
    guild_id: GuildId,
    user_id: UserId,
    complete: z.boolean(),
    channels: z.array(
      z.object({
        channel_id: z.string(),
        name: z.string(),
        type: z.number(),
        view: PermissionState,
        send: PermissionState,
        manage: PermissionState,
        reason: z.string(),
      }),
    ),
    warnings: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const [guild, member, roles, rawChannels] = await Promise.all([
      container.rest.get(Routes.guild(args.guild_id)) as Promise<{
        owner_id: string;
      }>,
      container.rest.get(Routes.guildMember(args.guild_id, args.user_id)) as Promise<{
        roles: string[];
        communication_disabled_until?: string | null;
      }>,
      container.rest.get(Routes.guildRoles(args.guild_id)) as Promise<RawRole[]>,
      container.rest.get(Routes.guildChannels(args.guild_id)) as Promise<RawChannel[]>,
    ]);
    // The report is scoped to the acting caller: channels it cannot view must
    // not be inventoried (names, types, or access outcomes) on its behalf.
    const visibleChannels = await filterCallerVisibleChannels(
      container.rest,
      args.guild_id,
      rawChannels,
      ctx?.caller?.id,
      ctx?.signal,
    );
    const channels = args.channel_ids
      ? visibleChannels.filter((c) => args.channel_ids!.includes(String(c.id)))
      : visibleChannels.slice(0, 100);
    const rolesById = new Map(roles.map((role) => [role.id, role]));
    const everyone = rolesById.get(args.guild_id);
    const warnings: string[] = [];
    let complete = everyone !== undefined;
    if (!everyone)
      return dualResult({
        text: 'Member access could not be evaluated because @everyone was absent from the role response.',
        data: {
          guild_id: args.guild_id,
          user_id: args.user_id,
          complete: false,
          channels: [],
          warnings: ['MISSING_EVERYONE_ROLE'],
        },
      });
    const roleIds = member.roles.filter((id) => id !== args.guild_id);
    const missing = member.roles.filter((id) => !rolesById.has(id));
    if (missing.length) {
      complete = false;
      warnings.push(`Missing role IDs: ${missing.join(', ')}`);
    }
    if (!args.channel_ids && visibleChannels.length > channels.length) {
      complete = false;
      warnings.push(
        `Channel report truncated to ${channels.length} channels; provide channel_ids for a bounded selection.`,
      );
    }
    if (args.channel_ids) {
      const returned = new Set(visibleChannels.map((channel) => String(channel.id)));
      const absent = args.channel_ids.filter((id) => !returned.has(id));
      if (absent.length) {
        complete = false;
        // IDs the caller cannot view are reported by ID only; Discord hides the
        // distinction from a guild listing, so the name is never guessed.
        warnings.push(`Requested channel IDs were not returned: ${absent.join(', ')}`);
      }
    }
    let base = BigInt(everyone.permissions);
    for (const id of member.roles) {
      const role = rolesById.get(id);
      if (role) base |= BigInt(role.permissions);
    }
    const administrator =
      (base & PermissionFlagsBits.Administrator) !== 0n || guild.owner_id === args.user_id;
    const result = channels.map((channel) => {
      const channelName = String((channel as RawChannel & { name?: unknown }).name ?? '');
      if (missing.length > 0) {
        complete = false;
        return {
          channel_id: String(channel.id),
          name: channelName,
          type: channel.type,
          view: 'unknown' as const,
          send: 'unknown' as const,
          manage: 'unknown' as const,
          reason: 'One or more member roles were missing from the guild role response.',
        };
      }
      if (
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread
      )
        return {
          channel_id: String(channel.id),
          name: channelName,
          type: channel.type,
          view: 'unknown' as const,
          send: 'unknown' as const,
          manage: 'unknown' as const,
          reason: 'Thread inheritance requires an explicit parent read and is reported as unknown.',
        };
      if (administrator)
        return {
          channel_id: String(channel.id),
          name: channelName,
          type: channel.type,
          view: 'allowed' as const,
          send: 'allowed' as const,
          manage: 'allowed' as const,
          reason: guild.owner_id === args.user_id ? 'Guild owner bypass.' : 'ADMINISTRATOR bypass.',
        };
      if (!channel.permission_overwrites) {
        complete = false;
        return {
          channel_id: String(channel.id),
          name: channelName,
          type: channel.type,
          view: 'unknown' as const,
          send: 'unknown' as const,
          manage: 'unknown' as const,
          reason: 'Discord omitted permission_overwrites.',
        };
      }
      const idx = indexPermissionOverwrites(channel.permission_overwrites);
      const everyoneOverwrite = idx.roles.get(args.guild_id);
      let effective = applyPermissionBits(
        base,
        everyoneOverwrite?.allow ?? 0n,
        everyoneOverwrite?.deny ?? 0n,
      );
      const roleOverwrites = combineRoleOverwriteBits(idx, roleIds);
      effective = applyPermissionBits(effective, roleOverwrites.allow, roleOverwrites.deny);
      const own = idx.members.get(args.user_id);
      effective = applyPermissionBits(effective, own?.allow ?? 0n, own?.deny ?? 0n);
      const state = (bit: bigint): 'allowed' | 'denied' =>
        (effective & bit) === bit ? 'allowed' : 'denied';
      const view = state(PermissionFlagsBits.ViewChannel);
      const send =
        view === 'denied'
          ? 'denied'
          : channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
            ? state(PermissionFlagsBits.Connect) === 'allowed' &&
              state(PermissionFlagsBits.Speak) === 'allowed'
              ? 'allowed'
              : 'denied'
            : state(PermissionFlagsBits.SendMessages);
      const timedOut = Boolean(
        member.communication_disabled_until &&
          Date.parse(member.communication_disabled_until) > Date.now(),
      );
      return {
        channel_id: String(channel.id),
        name: channelName,
        type: channel.type,
        view,
        send: timedOut ? ('denied' as const) : send,
        manage: timedOut ? ('denied' as const) : state(PermissionFlagsBits.ManageChannels),
        reason: timedOut
          ? 'Active timeout limits the member to read-only access.'
          : 'Resolved @everyone, member roles, and member overwrite in Discord order.',
      };
    });
    return dualResult({
      text: `Evaluated ${result.length} channel access view(s) for member ${args.user_id}.`,
      data: {
        guild_id: args.guild_id,
        user_id: args.user_id,
        complete,
        channels: result,
        warnings,
      },
    });
  },
});
