import { container } from '@sapphire/pieces';
import { ChannelType, OverwriteType, PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { DiscordNotFoundError, ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { PermissionString } from '../_lib/permissions.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, RoleId, Snowflake } from '../_lib/snowflake.js';
import {
  ALL_KNOWN_PERMISSION_BITS,
  applyPermissionBits,
  compareRoles,
  indexPermissionOverwrites,
  type PermissionOverwriteIndex,
  type RawChannel,
  type RawRole,
} from './_lib/evaluator.js';

const ACTIONS = ['view_channel', 'send_messages', 'manage_channel'] as const;
const AuditAction = z.enum(ACTIONS);
type AuditAction = (typeof ACTIONS)[number];

const DiscordRoleSchema = z.object({
  id: RoleId,
  name: z.string(),
  position: z.number().int().nonnegative(),
  permissions: PermissionString,
  managed: z.boolean(),
});
const DiscordRolesSchema = z.array(DiscordRoleSchema).superRefine((roles, context) => {
  const seen = new Set<string>();
  roles.forEach((role, index) => {
    if (seen.has(role.id)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: 'Duplicate role id in Discord response.',
      });
    }
    seen.add(role.id);
  });
});
const DiscordOverwriteSchema = z
  .object({
    id: Snowflake,
    type: z.union([z.literal(OverwriteType.Role), z.literal(OverwriteType.Member)]),
    allow: PermissionString,
    deny: PermissionString,
  })
  .superRefine((overwrite, context) => {
    if ((BigInt(overwrite.allow) & BigInt(overwrite.deny)) !== 0n) {
      context.addIssue({
        code: 'custom',
        path: ['allow'],
        message: 'Permission overwrite allow and deny bitfields overlap.',
      });
    }
  });
const DiscordOverwritesSchema = z
  .array(DiscordOverwriteSchema)
  .superRefine((overwrites, context) => {
    const seen = new Set<string>();
    overwrites.forEach((overwrite, index) => {
      const key = `${overwrite.type}:${overwrite.id}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Duplicate permission overwrite target in Discord response.',
        });
      }
      seen.add(key);
    });
  });
const DiscordChannelSchema = z.object({
  id: ChannelId,
  type: z.number().int(),
  guild_id: GuildId.optional(),
  parent_id: ChannelId.nullable().optional(),
  permission_overwrites: DiscordOverwritesSchema.optional(),
});

const THREAD_TYPES = new Set<number>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

const ActionDecisionsSchema = z.object({
  view_channel: z.boolean().nullable().optional(),
  send_messages: z.boolean().nullable().optional(),
  manage_channel: z.boolean().nullable().optional(),
});

const ActionCountsSchema = z.object({
  allowed: z.number().int().nonnegative(),
  denied: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

const ActionSummarySchema = z.object({
  view_channel: ActionCountsSchema.optional(),
  send_messages: ActionCountsSchema.optional(),
  manage_channel: ActionCountsSchema.optional(),
});

type ActionDecisions = Partial<Record<AuditAction, boolean | null>>;
type ActionCounts = { allowed: number; denied: number; unknown: number };

function fail(path: string, message: string): never {
  throw new ValidationError([{ path, message, code: 'custom' }]);
}

function parseDiscordResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  resource: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const suffix = issue && issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    fail(
      `discord_response.${resource}${suffix}`,
      `Discord returned malformed ${resource} data${issue ? `: ${issue.message}` : '.'}`,
    );
  }
  return parsed.data;
}

function hasPermission(effective: bigint, permission: bigint): boolean {
  return (effective & permission) === permission;
}

function decideAction(action: AuditAction, effective: bigint, isThread: boolean): boolean {
  if (!hasPermission(effective, PermissionFlagsBits.ViewChannel)) return false;
  if (action === 'view_channel') return true;
  if (action === 'manage_channel') {
    return hasPermission(
      effective,
      isThread ? PermissionFlagsBits.ManageThreads : PermissionFlagsBits.ManageChannels,
    );
  }
  return hasPermission(
    effective,
    isThread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
  );
}

function evaluateRole(options: {
  guildId: string;
  everyone: RawRole;
  role: RawRole;
  overwriteIndex: PermissionOverwriteIndex | null;
  permissionEvidenceComplete: boolean;
  isThread: boolean;
  isPrivateThread: boolean;
  requestedActions: readonly AuditAction[];
}): {
  administrator: boolean;
  actions: ActionDecisions;
} {
  let effective = BigInt(options.everyone.permissions);
  if (options.role.id !== options.guildId) effective |= BigInt(options.role.permissions);

  const administrator = hasPermission(effective, PermissionFlagsBits.Administrator);
  if (administrator) {
    return {
      administrator: true,
      actions: Object.fromEntries(options.requestedActions.map((action) => [action, true])),
    };
  }

  if (!options.permissionEvidenceComplete || !options.overwriteIndex) {
    return {
      administrator: false,
      actions: Object.fromEntries(options.requestedActions.map((action) => [action, null])),
    };
  }

  const everyoneOverwrite = options.overwriteIndex.roles.get(options.guildId);
  effective = applyPermissionBits(
    effective,
    everyoneOverwrite?.allow ?? 0n,
    everyoneOverwrite?.deny ?? 0n,
  );
  if (options.role.id !== options.guildId) {
    const roleOverwrite = options.overwriteIndex.roles.get(options.role.id);
    effective = applyPermissionBits(
      effective,
      roleOverwrite?.allow ?? 0n,
      roleOverwrite?.deny ?? 0n,
    );
  }

  if (options.isPrivateThread && !hasPermission(effective, PermissionFlagsBits.ManageThreads)) {
    return {
      administrator: false,
      actions: Object.fromEntries(options.requestedActions.map((action) => [action, null])),
    };
  }

  return {
    administrator: false,
    actions: Object.fromEntries(
      options.requestedActions.map((action) => [
        action,
        decideAction(action, effective, options.isThread),
      ]),
    ),
  };
}

export default defineTool({
  name: 'permissions_audit_channel',
  category: 'permissions',
  description: [
    '**Purpose**: Audit which individual guild roles can view, send in, or manage one channel or thread. Each role is evaluated independently with @everyone; member-specific overwrites and multi-role combinations are intentionally excluded. Thread management uses MANAGE_THREADS.',
    '',
    '**When to use**:',
    '- Review channel exposure before redesigning roles or permission overwrites.',
    '- Find role baselines that allow, deny, or cannot prove channel access.',
    '',
    '**When NOT to use**:',
    "- Determining one member's effective access; use `permissions_explain` for that member.",
    '- Predicting whether a locked or archived thread operation will succeed right now; this audits permission baselines, not mutable thread state.',
    '- Mutating roles or overwrites; this tool is read-only.',
    '',
    '**Returns**: a compact per-role action matrix plus allowed, denied, and unknown counts. Omit `actions` to audit all three actions; select fewer actions to reduce output.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild whose roles should be audited'),
    channel_id: ChannelId.describe(
      'Guild channel or thread whose role baselines should be audited',
    ),
    actions: z
      .array(AuditAction)
      .min(1)
      .max(ACTIONS.length)
      .optional()
      .describe('Optional action subset; defaults to view_channel, send_messages, manage_channel'),
  },
  outputSchema: {
    guild_id: GuildId,
    channel_id: ChannelId,
    permission_source_channel_id: ChannelId.nullable(),
    requested_actions: z.array(AuditAction),
    roles: z.array(
      z.object({
        id: RoleId,
        name: z.string(),
        position: z.number().int(),
        managed: z.boolean(),
        administrator: z.boolean(),
        actions: ActionDecisionsSchema,
      }),
    ),
    summary: z.object({
      role_count: z.number().int().nonnegative(),
      by_action: ActionSummarySchema,
    }),
    member_overwrite_count: z.number().int().nonnegative(),
    unknown_permission_bits: PermissionString,
    warnings: z.array(z.string()),
    confidence: z.enum(['complete', 'partial']),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const requestedActions = [
      ...new Set<AuditAction>((args.actions ?? ACTIONS) as readonly AuditAction[]),
    ];
    if (requestedActions.length === 0) fail('actions', 'Provide at least one action.');

    const [rawRoles, rawScopedChannel] = await Promise.all([
      container.rest.get(Routes.guildRoles(args.guild_id)),
      container.rest.get(Routes.channel(args.channel_id)),
    ]);
    const roles = parseDiscordResponse(DiscordRolesSchema, rawRoles, 'guild_roles') as RawRole[];
    const scopedChannel = parseDiscordResponse(
      DiscordChannelSchema,
      rawScopedChannel,
      'channel',
    ) as RawChannel;
    if (scopedChannel.id !== args.channel_id) {
      fail('discord_response.channel.id', 'Discord returned a different channel than requested.');
    }
    if (scopedChannel.guild_id !== args.guild_id) {
      fail('channel_id', 'The channel does not belong to guild_id.');
    }

    const everyone = roles.find((role) => role.id === args.guild_id);
    if (!everyone) throw new DiscordNotFoundError('role', args.guild_id);

    const warnings: string[] = [];
    const isThread = THREAD_TYPES.has(scopedChannel.type);
    const isPrivateThread = scopedChannel.type === ChannelType.PrivateThread;
    let permissionChannel: RawChannel | null = scopedChannel;
    let permissionEvidenceComplete = true;

    if (isThread) {
      if (!scopedChannel.parent_id) {
        permissionChannel = null;
        permissionEvidenceComplete = false;
        warnings.push('Thread payload omitted parent_id, so inherited permissions are unknown.');
      } else {
        const rawParent = await container.rest.get(Routes.channel(scopedChannel.parent_id));
        permissionChannel = parseDiscordResponse(
          DiscordChannelSchema,
          rawParent,
          'thread_parent',
        ) as RawChannel;
        if (permissionChannel.id !== scopedChannel.parent_id) {
          fail(
            'discord_response.thread_parent.id',
            'Discord returned a different thread parent than requested.',
          );
        }
        if (permissionChannel.guild_id !== args.guild_id) {
          fail('channel_id', 'The thread parent does not belong to guild_id.');
        }
      }
    }

    if (permissionChannel?.permission_overwrites === undefined) {
      permissionEvidenceComplete = false;
      warnings.push('Channel payload omitted permission_overwrites, so role access is incomplete.');
    }

    const overwriteIndex = permissionChannel?.permission_overwrites
      ? indexPermissionOverwrites(permissionChannel.permission_overwrites)
      : null;
    const observedPermissions = roles.reduce(
      (bits, role) => bits | BigInt(role.permissions),
      overwriteIndex?.observed ?? 0n,
    );
    const unknownPermissionBits = observedPermissions & ~ALL_KNOWN_PERMISSION_BITS;
    const memberOverwriteCount = overwriteIndex?.members.size ?? 0;
    if (memberOverwriteCount > 0) {
      warnings.push(
        `${memberOverwriteCount} member-specific overwrite(s) are intentionally excluded from this role-level audit.`,
      );
    }
    if (isPrivateThread) {
      warnings.push(
        'Discord does not expose private-thread membership by role; non-administrator roles without MANAGE_THREADS remain unknown.',
      );
    }
    if (unknownPermissionBits !== 0n) {
      warnings.push(
        `Discord returned permission bits unknown to this build: ${unknownPermissionBits.toString()}.`,
      );
    }

    const sortedRoles = [...roles].sort((left, right) => compareRoles(right, left));
    const roleResults = sortedRoles.map((role) => ({
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed,
      ...evaluateRole({
        guildId: args.guild_id,
        everyone,
        role,
        overwriteIndex,
        permissionEvidenceComplete,
        isThread,
        isPrivateThread,
        requestedActions,
      }),
    }));

    const byAction: Partial<Record<AuditAction, ActionCounts>> = {};
    for (const action of requestedActions) {
      const counts: ActionCounts = { allowed: 0, denied: 0, unknown: 0 };
      for (const role of roleResults) {
        const decision = role.actions[action];
        if (decision === true) counts.allowed += 1;
        else if (decision === false) counts.denied += 1;
        else counts.unknown += 1;
      }
      byAction[action] = counts;
    }

    const confidence =
      unknownPermissionBits !== 0n ||
      Object.values(byAction).some((counts) => (counts?.unknown ?? 0) > 0)
        ? ('partial' as const)
        : ('complete' as const);
    const status = confidence === 'complete' ? 'COMPLETE' : 'PARTIAL';
    return dualResult({
      text: [
        `**Channel role audit: ${status}**`,
        `Scope: \`channel:${args.channel_id}\` in \`guild:${args.guild_id}\``,
        `Roles: ${roleResults.length}`,
        ...requestedActions.map((action) => {
          const counts = byAction[action] as ActionCounts;
          return `${action}: ${counts.allowed} allowed, ${counts.denied} denied, ${counts.unknown} unknown`;
        }),
        ...(warnings.length > 0 ? [`Warnings: ${warnings.join(' ')}`] : []),
      ].join('\n'),
      data: {
        guild_id: args.guild_id,
        channel_id: args.channel_id,
        permission_source_channel_id: permissionChannel?.id ?? null,
        requested_actions: requestedActions,
        roles: roleResults,
        summary: { role_count: roleResults.length, by_action: byAction },
        member_overwrite_count: memberOverwriteCount,
        unknown_permission_bits: unknownPermissionBits.toString(),
        warnings,
        confidence,
      },
    });
  },
});
