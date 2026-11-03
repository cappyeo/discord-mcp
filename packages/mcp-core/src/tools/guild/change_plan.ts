import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { verifyExpectedBotIdentity } from '../../identity-lock.js';
import { filterCallerVisibleChannels } from '../_lib/caller-visibility.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import { blueprintSigningSecret } from './_lib/blueprint.trust.js';
import {
  createGuildChangePlan,
  GuildChangeRequestSchema,
  type GuildChangeSnapshot,
  saveGuildChangePlan,
  snapshotDigest,
} from './_lib/guild-change.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Blocker = z.object({
  code: z.string(),
  message: z.string(),
  resource: z.string().nullable(),
  recovery_hint: z.string(),
});

function applyPatch(before: Record<string, unknown>, patch: Record<string, unknown>) {
  return {
    ...before,
    ...Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, value === undefined ? before[key] : value]),
    ),
  };
}
function changedProjection(before: Record<string, unknown>, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  return {
    fields: keys,
    before: Object.fromEntries(keys.map((key) => [key, before[key] ?? null])),
    after: Object.fromEntries(keys.map((key) => [key, patch[key] ?? null])),
  };
}

export default defineTool({
  name: 'guild_change_plan',
  category: 'guild',
  description: [
    '**Purpose**: Inspect an existing guild and create a target-bound, read-only change plan for bounded channel, role, ordering, and permission-overwrite edits.',
    '',
    '**Safety**: Existing IDs are preserved; omitted fields are untouched; creates and deletes are not accepted. The live snapshot, before/after diff, blockers, and approval-bound plan reference must be reviewed before apply.',
    '',
    '**Returns**: `{status, plan_id, plan_ref, approval_id, snapshot_id, operations, blockers, risks}`.',
  ].join('\n'),
  preconditions: ['explicit_guild_required'] as const,
  inputSchema: {
    guild_id: GuildId.describe('Explicit existing guild to inspect'),
    expected_bot_id: UserId.describe('Exact caller-owned bot ID'),
    request: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe('Natural-language explanation of the requested improvement'),
    changes: GuildChangeRequestSchema.describe('Typed bounded edits translated from the request'),
  },
  outputSchema: {
    status: z.enum(['ready', 'blocked']),
    plan_id: Digest.nullable(),
    plan_ref: z.string().nullable(),
    approval_id: Digest.nullable(),
    snapshot_id: Digest.nullable(),
    operations: z.array(z.unknown()),
    blockers: z.array(Blocker),
    risks: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    await verifyExpectedBotIdentity(container.rest, args.expected_bot_id);
    const [guild, bot, roles, channels] = await Promise.all([
      container.rest.get(Routes.guild(args.guild_id)) as Promise<Record<string, unknown>>,
      container.rest.get(Routes.guildMember(args.guild_id, args.expected_bot_id)) as Promise<
        Record<string, unknown>
      >,
      container.rest.get(Routes.guildRoles(args.guild_id)) as Promise<
        Array<Record<string, unknown>>
      >,
      container.rest.get(Routes.guildChannels(args.guild_id)) as Promise<
        Array<Record<string, unknown>>
      >,
    ]);
    // The plan echoes live channel objects; keep them to the caller's own view
    // so an OAuth2 caller never receives names/overwrites it cannot see.
    const callerChannels = await filterCallerVisibleChannels(
      container.rest,
      args.guild_id,
      channels as unknown as Array<{ id: string; type: number; parent_id?: string | null }>,
      ctx?.caller?.id,
      ctx?.signal,
    );
    const visibleChannelIds = new Set(callerChannels.map((channel) => String(channel.id)));
    const before: GuildChangeSnapshot = {
      guild,
      bot_roles: Array.isArray(bot.roles) ? (bot.roles as string[]) : [],
      roles,
      channels,
    };
    const roleById = new Map(roles.map((role) => [String(role.id), role]));
    const channelById = new Map(channels.map((channel) => [String(channel.id), channel]));
    const blockers: Array<{
      code: string;
      message: string;
      resource: string | null;
      recovery_hint: string;
    }> = [];
    const operations: Array<Record<string, unknown>> = [];
    const changes = GuildChangeRequestSchema.parse(args.changes);
    const botRoleIds = Array.isArray(bot.roles) ? (bot.roles as string[]) : [];
    const botTopPosition = Math.max(
      0,
      ...botRoleIds.map((id) => Number(roleById.get(id)?.position ?? 0)),
    );
    const everyone = roleById.get(args.guild_id);
    let botPermissions = everyone ? BigInt(String(everyone.permissions ?? '0')) : 0n;
    for (const roleId of botRoleIds) {
      const role = roleById.get(roleId);
      if (role) botPermissions |= BigInt(String(role.permissions ?? '0'));
    }
    const isAdministrator = (botPermissions & 8n) === 8n;
    if (
      !isAdministrator &&
      changes.roles.length > 0 &&
      (botPermissions & 268435456n) !== 268435456n
    )
      blockers.push({
        code: 'BOT_MANAGE_ROLES',
        message: 'The caller bot cannot prove MANAGE_ROLES for the requested role edits.',
        resource: args.guild_id,
        recovery_hint: 'Grant the bot MANAGE_ROLES or remove role changes.',
      });
    if (!isAdministrator && changes.channels.length > 0 && (botPermissions & 16n) !== 16n)
      blockers.push({
        code: 'BOT_MANAGE_CHANNELS',
        message: 'The caller bot cannot prove MANAGE_CHANNELS for the requested channel edits.',
        resource: args.guild_id,
        recovery_hint: 'Grant the bot MANAGE_CHANNELS or remove channel changes.',
      });
    if (
      !isAdministrator &&
      changes.permission_overwrites.length > 0 &&
      (botPermissions & 268435456n) !== 268435456n
    )
      blockers.push({
        code: 'BOT_MANAGE_ROLES',
        message:
          'The caller bot cannot prove MANAGE_ROLES for the requested permission overwrites.',
        resource: args.guild_id,
        recovery_hint: 'Grant the bot MANAGE_ROLES or remove permission overwrite changes.',
      });
    const requestedParents = new Map(
      changes.channels
        .filter((item) => item.patch.parent_id !== undefined)
        .map((item) => [item.id, item.patch.parent_id]),
    );
    for (const start of requestedParents.keys()) {
      const seen = new Set<string>();
      let current: string | null | undefined = start;
      while (current && requestedParents.has(current)) {
        if (seen.has(current)) {
          blockers.push({
            code: 'PARENT_CYCLE',
            message: `Channel parent changes contain a cycle involving ${start}.`,
            resource: start,
            recovery_hint: 'Choose an existing category without a cycle.',
          });
          break;
        }
        seen.add(current);
        current = requestedParents.get(current);
      }
    }
    for (const item of changes.roles) {
      const role = roleById.get(item.id);
      if (!role) {
        blockers.push({
          code: 'ROLE_NOT_FOUND',
          message: `Role ${item.id} was not found.`,
          resource: item.id,
          recovery_hint: 'Refresh the live guild and create a new plan.',
        });
        continue;
      }
      if (role.managed === true) {
        blockers.push({
          code: 'MANAGED_ROLE',
          message: `Role ${item.id} is Discord-managed.`,
          resource: item.id,
          recovery_hint: 'Choose a caller-owned role.',
        });
        continue;
      }
      if (item.patch.permissions !== undefined && !isAdministrator) {
        const requested = BigInt(item.patch.permissions);
        if ((requested & ~botPermissions) !== 0n) {
          blockers.push({
            code: 'ROLE_PERMISSION_SCOPE',
            message: `Role ${item.id} requests permissions outside the caller bot's grants.`,
            resource: item.id,
            recovery_hint: 'Request only permissions held by the caller bot.',
          });
          continue;
        }
      }
      if (item.id === args.guild_id) {
        blockers.push({
          code: 'EVERYONE_ROLE_LIMIT',
          message: 'The @everyone role cannot be edited in this change surface.',
          resource: item.id,
          recovery_hint: 'Use a caller-owned role for permission changes.',
        });
        continue;
      }
      if (Number(role.position ?? 0) >= botTopPosition) {
        blockers.push({
          code: 'ROLE_HIERARCHY',
          message: `Role ${item.id} is not below the caller bot's top role.`,
          resource: item.id,
          recovery_hint: "Choose a role below the caller bot's highest role.",
        });
        continue;
      }
      const after = applyPatch(role, item.patch as Record<string, unknown>);
      operations.push({
        kind: 'role_patch',
        resource_id: item.id,
        before: role,
        after,
        changed: changedProjection(role, item.patch as Record<string, unknown>),
      });
    }
    for (const item of changes.channels) {
      const channel = channelById.get(item.id);
      if (!channel || !visibleChannelIds.has(item.id)) {
        blockers.push({
          code: 'CHANNEL_NOT_FOUND',
          message: `Channel ${item.id} was not found.`,
          resource: item.id,
          recovery_hint: 'Refresh the live guild and create a new plan.',
        });
        continue;
      }
      if (
        item.patch.parent_id !== undefined &&
        item.patch.parent_id !== null &&
        (!channelById.has(item.patch.parent_id) ||
          Number(channelById.get(item.patch.parent_id)?.type) !== 4)
      ) {
        blockers.push({
          code: 'PARENT_NOT_FOUND',
          message: `Parent channel ${item.patch.parent_id} was not found.`,
          resource: item.id,
          recovery_hint: 'Use an existing category ID.',
        });
        continue;
      }
      operations.push({
        kind: 'channel_patch',
        resource_id: item.id,
        before: channel,
        after: applyPatch(channel, item.patch as Record<string, unknown>),
        changed: changedProjection(channel, item.patch as Record<string, unknown>),
      });
    }
    for (const item of changes.permission_overwrites) {
      const channel = channelById.get(item.channel_id);
      if (!channel || !visibleChannelIds.has(item.channel_id)) {
        blockers.push({
          code: 'CHANNEL_NOT_FOUND',
          message: `Permission channel ${item.channel_id} was not found.`,
          resource: item.channel_id,
          recovery_hint: 'Refresh the live guild and create a new plan.',
        });
        continue;
      }
      const targetRole = roleById.get(item.overwrite_id);
      if (item.type === 0 && !targetRole && item.overwrite_id !== args.guild_id) {
        blockers.push({
          code: 'ROLE_NOT_FOUND',
          message: `Overwrite target role ${item.overwrite_id} was not found.`,
          resource: item.overwrite_id,
          recovery_hint: 'Refresh the live guild and choose an existing role.',
        });
        continue;
      }
      const current = Array.isArray(channel.permission_overwrites)
        ? channel.permission_overwrites.find(
            (o) => String((o as Record<string, unknown>).id) === item.overwrite_id,
          )
        : undefined;
      operations.push({
        kind: 'permission_overwrite',
        resource_id: `${item.channel_id}/${item.overwrite_id}`,
        before: current ?? null,
        after: item,
        changed: {
          fields: ['type', 'allow', 'deny'],
          before: {
            type: current?.type ?? null,
            allow: current?.allow ?? '0',
            deny: current?.deny ?? '0',
          },
          after: {
            type: item.type,
            allow: item.allow ?? current?.allow ?? '0',
            deny: item.deny ?? current?.deny ?? '0',
          },
        },
      });
    }
    const snapshot_id = snapshotDigest(before);
    if (blockers.length > 0 || operations.length === 0)
      return dualResult({
        text: blockers.length
          ? `Guild change plan blocked: ${blockers.map((b) => b.code).join(', ')}.`
          : 'Guild change plan contains no operations.',
        data: {
          status: 'blocked' as const,
          plan_id: null,
          plan_ref: null,
          approval_id: null,
          snapshot_id,
          operations,
          blockers,
          risks: ['No mutation was attempted.'],
        },
      });
    const plan = createGuildChangePlan(
      {
        schema_version: 'guild_change_plan.v1',
        guild_id: args.guild_id,
        bot_id: args.expected_bot_id,
        request: args.request,
        changes,
        before,
      },
      blueprintSigningSecret(container.config),
    );
    const plan_ref = await saveGuildChangePlan(plan, container.config);
    return dualResult({
      text: `Prepared ${operations.length} existing-guild change(s) for review. No Discord mutation was attempted.`,
      data: {
        status: 'ready' as const,
        plan_id: plan.plan_id,
        plan_ref,
        approval_id: plan.approval_id,
        snapshot_id,
        operations,
        blockers: [],
        risks: [
          'Apply refuses external drift and preserves resource IDs. Unsupported creates/deletes are excluded.',
        ],
      },
    });
  },
});
