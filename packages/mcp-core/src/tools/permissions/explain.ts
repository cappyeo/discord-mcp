import { container } from '@sapphire/pieces';
import { ChannelType, OverwriteType, PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { DiscordNotFoundError, ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { PermissionString } from '../_lib/permissions.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, RoleId, Snowflake, UserId } from '../_lib/snowflake.js';

function permissionName(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).map(
  ([name, bit]) => [permissionName(name), bit] as const,
);
const PERMISSIONS_BY_NAME = new Map<string, bigint>(PERMISSION_ENTRIES);
const PERMISSION_NAMES = [...PERMISSIONS_BY_NAME.keys()] as [string, ...string[]];
const PermissionName = z.enum(PERMISSION_NAMES);
const ALL_KNOWN_PERMISSIONS = PERMISSION_ENTRIES.reduce((mask, [, bit]) => mask | bit, 0n);

const ACTIONS = [
  'view_channel',
  'send_messages',
  'manage_channel',
  'assign_role',
  'remove_role',
  'kick_member',
  'ban_member',
  'timeout_member',
] as const;
const PermissionAction = z.enum(ACTIONS);
type PermissionAction = (typeof ACTIONS)[number];

const DECISION_STAGES = [
  'guild_everyone',
  'guild_roles',
  'guild_owner',
  'administrator',
  'channel_everyone',
  'channel_roles',
  'channel_member',
  'member_timeout',
] as const;
type DecisionStage = (typeof DECISION_STAGES)[number];

const HIERARCHY_ACTIONS = new Set<PermissionAction>([
  'assign_role',
  'remove_role',
  'kick_member',
  'ban_member',
  'timeout_member',
]);
const CHANNEL_ACTIONS = new Set<PermissionAction>([
  'view_channel',
  'send_messages',
  'manage_channel',
]);
const THREAD_TYPES = new Set<number>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);
const VOICE_TYPES = new Set<number>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const CHANNEL_SCOPED_PERMISSIONS = new Set([
  'CREATE_INSTANT_INVITE',
  'MANAGE_CHANNELS',
  'ADD_REACTIONS',
  'PRIORITY_SPEAKER',
  'STREAM',
  'SEND_MESSAGES',
  'SEND_TTS_MESSAGES',
  'MANAGE_MESSAGES',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'READ_MESSAGE_HISTORY',
  'MENTION_EVERYONE',
  'USE_EXTERNAL_EMOJIS',
  'CONNECT',
  'SPEAK',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'MOVE_MEMBERS',
  'USE_VAD',
  'MANAGE_ROLES',
  'MANAGE_WEBHOOKS',
  'USE_APPLICATION_COMMANDS',
  'REQUEST_TO_SPEAK',
  'MANAGE_THREADS',
  'CREATE_PUBLIC_THREADS',
  'CREATE_PRIVATE_THREADS',
  'USE_EXTERNAL_STICKERS',
  'SEND_MESSAGES_IN_THREADS',
  'USE_EMBEDDED_ACTIVITIES',
  'USE_SOUNDBOARD',
  'USE_EXTERNAL_SOUNDS',
  'SEND_VOICE_MESSAGES',
  'SET_VOICE_CHANNEL_STATUS',
  'SEND_POLLS',
  'USE_EXTERNAL_APPS',
  'PIN_MESSAGES',
  'BYPASS_SLOWMODE',
]);
const SEND_DEPENDENT_PERMISSIONS = new Set([
  'SEND_TTS_MESSAGES',
  'MENTION_EVERYONE',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'SEND_VOICE_MESSAGES',
  'SEND_POLLS',
]);
const CONNECT_DEPENDENT_PERMISSIONS = new Set([
  'PRIORITY_SPEAKER',
  'STREAM',
  'SPEAK',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'MOVE_MEMBERS',
  'USE_VAD',
  'REQUEST_TO_SPEAK',
  'USE_SOUNDBOARD',
  'USE_EXTERNAL_SOUNDS',
  'SET_VOICE_CHANNEL_STATUS',
]);

interface RawGuild {
  id: string;
  owner_id: string;
}

interface RawRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
}

interface RawMember {
  user: { id: string };
  roles: string[];
  communication_disabled_until?: string | null;
}

interface RawOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface RawChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  permission_overwrites?: RawOverwrite[];
}

interface DecisionTraceEntry {
  stage: DecisionStage;
  before: string;
  allow: string;
  deny: string;
  after: string;
  note: string;
}

interface HierarchyResult {
  status: 'not_applicable' | 'allowed' | 'denied' | 'unknown';
  allowed: boolean | null;
  actor_top_role_id: string | null;
  target_top_role_id: string | null;
  reason: string;
}

function fail(path: string, message: string): never {
  throw new ValidationError([{ path, message, code: 'custom' }]);
}

function applyPermissions(
  trace: DecisionTraceEntry[],
  stage: DecisionStage,
  before: bigint,
  allow: bigint,
  deny: bigint,
  note: string,
): bigint {
  const after = (before & ~deny) | allow;
  trace.push({
    stage,
    before: before.toString(),
    allow: allow.toString(),
    deny: deny.toString(),
    after: after.toString(),
    note,
  });
  return after;
}

function compareRoles(left: RawRole, right: RawRole): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.id === right.id) return 0;
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

function highestRole(
  roleIds: readonly string[],
  rolesById: ReadonlyMap<string, RawRole>,
  everyone: RawRole,
): RawRole {
  let highest = everyone;
  for (const roleId of roleIds) {
    const role = rolesById.get(roleId);
    if (role && compareRoles(role, highest) > 0) highest = role;
  }
  return highest;
}

function permissionsForAction(action: PermissionAction, isThread: boolean): string[] {
  switch (action) {
    case 'view_channel':
      return ['VIEW_CHANNEL'];
    case 'send_messages':
      return ['VIEW_CHANNEL', isThread ? 'SEND_MESSAGES_IN_THREADS' : 'SEND_MESSAGES'];
    case 'manage_channel':
      return ['VIEW_CHANNEL', 'MANAGE_CHANNELS'];
    case 'assign_role':
    case 'remove_role':
      return ['MANAGE_ROLES'];
    case 'kick_member':
      return ['KICK_MEMBERS'];
    case 'ban_member':
      return ['BAN_MEMBERS'];
    case 'timeout_member':
      return ['MODERATE_MEMBERS'];
  }
}

function missingPrerequisites(requested: string, effective: bigint, channelType: number): string[] {
  const prerequisites: string[] = [];
  if (requested !== 'VIEW_CHANNEL' && CHANNEL_SCOPED_PERMISSIONS.has(requested)) {
    prerequisites.push('VIEW_CHANNEL');
  }
  if (SEND_DEPENDENT_PERMISSIONS.has(requested)) {
    prerequisites.push(
      THREAD_TYPES.has(channelType) ? 'SEND_MESSAGES_IN_THREADS' : 'SEND_MESSAGES',
    );
  }
  if (requested === 'SEND_MESSAGES' && THREAD_TYPES.has(channelType)) {
    prerequisites.push('SEND_MESSAGES_IN_THREADS');
  }
  if (VOICE_TYPES.has(channelType) && CONNECT_DEPENDENT_PERMISSIONS.has(requested)) {
    prerequisites.push('CONNECT');
  }
  return [...new Set(prerequisites)].filter((name) => {
    const bit = PERMISSIONS_BY_NAME.get(name);
    return bit !== undefined && (effective & bit) !== bit;
  });
}

function hierarchyNotApplicable(): HierarchyResult {
  return {
    status: 'not_applicable',
    allowed: null,
    actor_top_role_id: null,
    target_top_role_id: null,
    reason: 'The requested check does not depend on Discord role hierarchy.',
  };
}

function evaluateHierarchy(options: {
  action: PermissionAction | undefined;
  actorId: string | undefined;
  actorRoleIds: readonly string[];
  actorIsOwner: boolean;
  targetMember: RawMember | null;
  targetRole: RawRole | null;
  guildOwnerId: string;
  everyoneRole: RawRole;
  rolesById: ReadonlyMap<string, RawRole>;
  missingActorRoleIds: readonly string[];
  missingTargetRoleIds: readonly string[];
}): HierarchyResult {
  if (!options.action || !HIERARCHY_ACTIONS.has(options.action)) return hierarchyNotApplicable();
  const actorTop = highestRole(options.actorRoleIds, options.rolesById, options.everyoneRole);
  const targetTop = options.targetRole
    ? options.targetRole
    : options.targetMember
      ? highestRole(options.targetMember.roles, options.rolesById, options.everyoneRole)
      : null;
  const base = {
    actor_top_role_id: actorTop.id,
    target_top_role_id: targetTop?.id ?? null,
  };

  if (options.missingActorRoleIds.length > 0 || options.missingTargetRoleIds.length > 0) {
    return {
      ...base,
      status: 'unknown',
      allowed: null,
      reason: 'One or more member role IDs were absent from the guild role list.',
    };
  }
  if (!targetTop) {
    return {
      ...base,
      status: 'unknown',
      allowed: null,
      reason: 'No hierarchy target was resolved.',
    };
  }
  if (options.targetRole) {
    if (options.targetRole.id === options.everyoneRole.id) {
      return {
        ...base,
        status: 'denied',
        allowed: false,
        reason: 'The @everyone role cannot be assigned or removed.',
      };
    }
    if (options.targetRole.managed) {
      return {
        ...base,
        status: 'denied',
        allowed: false,
        reason: 'Discord-managed roles cannot be assigned or removed manually.',
      };
    }
  }
  if (options.targetMember?.user.id === options.guildOwnerId) {
    return {
      ...base,
      status: 'denied',
      allowed: false,
      reason: 'The guild owner cannot be moderated through role hierarchy.',
    };
  }
  if (options.actorId && options.targetMember?.user.id === options.actorId) {
    return {
      ...base,
      status: 'denied',
      allowed: false,
      reason: 'A member cannot perform this moderation action on itself.',
    };
  }
  if (options.action === 'timeout_member' && options.targetMember) {
    const targetRoleIds = [options.everyoneRole.id, ...options.targetMember.roles];
    const targetIsAdministrator = targetRoleIds.some((roleId) => {
      const role = options.rolesById.get(roleId);
      return role && (BigInt(role.permissions) & PermissionFlagsBits.Administrator) !== 0n;
    });
    if (targetIsAdministrator) {
      return {
        ...base,
        status: 'denied',
        allowed: false,
        reason: 'Discord rejects timeouts for members with ADMINISTRATOR permission.',
      };
    }
  }
  if (options.actorIsOwner) {
    return {
      ...base,
      status: 'allowed',
      allowed: true,
      reason: 'The guild owner bypasses member and role position comparisons.',
    };
  }
  if (compareRoles(actorTop, targetTop) <= 0) {
    return {
      ...base,
      status: 'denied',
      allowed: false,
      reason: 'The actor highest role must be strictly above the target highest role.',
    };
  }
  return {
    ...base,
    status: 'allowed',
    allowed: true,
    reason: 'The actor highest role is above the target highest role.',
  };
}

const DecisionTraceSchema = z.object({
  stage: z.enum(DECISION_STAGES),
  before: PermissionString,
  allow: PermissionString,
  deny: PermissionString,
  after: PermissionString,
  note: z.string(),
});

const HierarchySchema = z.object({
  status: z.enum(['not_applicable', 'allowed', 'denied', 'unknown']),
  allowed: z.boolean().nullable(),
  actor_top_role_id: RoleId.nullable(),
  target_top_role_id: RoleId.nullable(),
  reason: z.string(),
});

export default defineTool({
  name: 'permissions_explain',
  category: 'permissions',
  description: [
    '**Purpose**: Explain effective Discord permissions for one guild member or one role.',
    '',
    '**When to use**:',
    '- Verify a permission or supported action before a write.',
    '- Diagnose why Discord allows, denies, or cannot conclusively evaluate an action.',
    '',
    '**When NOT to use**:',
    '- Mutating roles or overwrites; this tool is read-only.',
    '- Treating a partial result as permission to write.',
    '',
    '**Returns**: `{allowed, effective_permissions, missing_permissions, ineffective_permissions, decision_trace, role_hierarchy_check, warnings, confidence}`. `allowed:null` means Discord did not expose enough evidence for a safe conclusion.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild whose permission state should be evaluated'),
    channel_id: ChannelId.optional().describe(
      'Optional guild channel or thread scope. Required for channel actions.',
    ),
    user_id: UserId.optional().describe('Member to evaluate; mutually exclusive with role_id'),
    role_id: RoleId.optional().describe('Role to evaluate; mutually exclusive with user_id'),
    requested_permissions: z
      .array(PermissionName)
      .min(1)
      .max(PERMISSION_NAMES.length)
      .optional()
      .describe('Discord permission constants such as VIEW_CHANNEL or SEND_MESSAGES'),
    action: PermissionAction.optional().describe(
      'Optional high-level action; translated into its required permission constants',
    ),
    target_user_id: UserId.optional().describe(
      'Target member; required for kick_member, ban_member, or timeout_member',
    ),
    target_role_id: RoleId.optional().describe(
      'Target role; required for assign_role or remove_role',
    ),
  },
  outputSchema: {
    guild_id: GuildId,
    channel_id: ChannelId.nullable(),
    permission_source_channel_id: ChannelId.nullable(),
    subject_type: z.enum(['member', 'role']),
    subject_id: Snowflake.describe('Discord member or role ID'),
    action: PermissionAction.nullable(),
    requested_permissions: z.array(PermissionName),
    allowed: z.boolean().nullable(),
    base_permissions: PermissionString,
    effective_permissions: PermissionString,
    unknown_permission_bits: PermissionString,
    missing_permissions: z.array(PermissionName),
    ineffective_permissions: z.array(PermissionName),
    implicit_denies: z.array(
      z.object({
        permission: PermissionName,
        missing_prerequisites: z.array(PermissionName),
        reason: z.string(),
      }),
    ),
    administrator: z.boolean(),
    guild_owner: z.boolean(),
    subject_timed_out: z.boolean(),
    applied_role_ids: z.array(RoleId),
    decision_trace: z.array(DecisionTraceSchema),
    role_hierarchy_check: HierarchySchema,
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
    const hasUser = args.user_id !== undefined;
    const hasRole = args.role_id !== undefined;
    if (hasUser === hasRole) {
      fail('user_id', 'Provide exactly one of user_id or role_id.');
    }
    if (!args.action && !args.requested_permissions) {
      fail('requested_permissions', 'Provide requested_permissions, action, or both.');
    }
    if (args.action && CHANNEL_ACTIONS.has(args.action) && !args.channel_id) {
      fail('channel_id', `${args.action} requires channel_id.`);
    }
    if (args.action && HIERARCHY_ACTIONS.has(args.action) && !hasUser) {
      fail('user_id', `${args.action} requires a member actor, not a role-only subject.`);
    }
    if (args.action === 'assign_role' || args.action === 'remove_role') {
      if (!args.target_role_id) fail('target_role_id', `${args.action} requires target_role_id.`);
    } else if (args.target_role_id) {
      fail('target_role_id', 'target_role_id is only valid for assign_role or remove_role.');
    }
    if (
      args.action === 'kick_member' ||
      args.action === 'ban_member' ||
      args.action === 'timeout_member'
    ) {
      if (!args.target_user_id) fail('target_user_id', `${args.action} requires target_user_id.`);
    } else if (args.target_user_id) {
      fail(
        'target_user_id',
        'target_user_id is only valid for kick_member, ban_member, or timeout_member.',
      );
    }

    const subjectMemberPromise = hasUser
      ? (container.rest.get(
          Routes.guildMember(args.guild_id, args.user_id as string),
        ) as Promise<RawMember>)
      : Promise.resolve(null);
    const targetMemberPromise = args.target_user_id
      ? args.target_user_id === args.user_id
        ? subjectMemberPromise
        : (container.rest.get(
            Routes.guildMember(args.guild_id, args.target_user_id),
          ) as Promise<RawMember>)
      : Promise.resolve(null);
    const channelPromise = args.channel_id
      ? (container.rest.get(Routes.channel(args.channel_id)) as Promise<RawChannel>)
      : Promise.resolve(null);
    const [guild, roles, subjectMember, targetMember, scopedChannel] = await Promise.all([
      container.rest.get(Routes.guild(args.guild_id)) as Promise<RawGuild>,
      container.rest.get(Routes.guildRoles(args.guild_id)) as Promise<RawRole[]>,
      subjectMemberPromise,
      targetMemberPromise,
      channelPromise,
    ]);

    const rolesById = new Map(roles.map((role) => [role.id, role]));
    const everyone = rolesById.get(args.guild_id);
    if (!everyone) throw new DiscordNotFoundError('role', args.guild_id);
    const subjectRole = hasRole ? rolesById.get(args.role_id as string) : undefined;
    if (hasRole && !subjectRole) throw new DiscordNotFoundError('role', args.role_id as string);
    const targetRole = args.target_role_id ? rolesById.get(args.target_role_id) : undefined;
    if (args.target_role_id && !targetRole) {
      throw new DiscordNotFoundError('role', args.target_role_id);
    }

    if (scopedChannel && scopedChannel.guild_id !== args.guild_id) {
      fail('channel_id', 'The channel does not belong to guild_id.');
    }

    const actorRoleIds = subjectMember?.roles ?? (subjectRole ? [subjectRole.id] : []);
    const missingActorRoleIds = actorRoleIds.filter((roleId) => !rolesById.has(roleId));
    const missingTargetRoleIds =
      targetMember?.roles.filter((roleId) => !rolesById.has(roleId)) ?? [];
    const warnings: string[] = [];
    if (missingActorRoleIds.length > 0) {
      warnings.push(
        `Member references missing guild roles: ${missingActorRoleIds.join(', ')}. The result may be stale.`,
      );
    }
    if (missingTargetRoleIds.length > 0) {
      warnings.push(
        `Target member references missing guild roles: ${missingTargetRoleIds.join(', ')}. Hierarchy is unknown.`,
      );
    }
    let permissionEvidenceComplete = missingActorRoleIds.length === 0;

    const trace: DecisionTraceEntry[] = [];
    let effective = applyPermissions(
      trace,
      'guild_everyone',
      0n,
      BigInt(everyone.permissions),
      0n,
      'Start with the guild @everyone role.',
    );
    let observedPermissions = BigInt(everyone.permissions);
    let rolePermissions = 0n;
    const resolvedActorRoles: RawRole[] = [];
    for (const roleId of actorRoleIds) {
      const role = rolesById.get(roleId);
      if (!role || role.id === args.guild_id) continue;
      resolvedActorRoles.push(role);
      const permissions = BigInt(role.permissions);
      rolePermissions |= permissions;
      observedPermissions |= permissions;
    }
    effective = applyPermissions(
      trace,
      'guild_roles',
      effective,
      rolePermissions,
      0n,
      `Union permissions from ${resolvedActorRoles.length} resolved subject role(s).`,
    );
    const basePermissions = effective;
    const guildOwner = hasUser && args.user_id === guild.owner_id;
    const administrator = (basePermissions & PermissionFlagsBits.Administrator) !== 0n;
    const subjectTimedOut = Boolean(
      subjectMember?.communication_disabled_until &&
        Date.parse(subjectMember.communication_disabled_until) > Date.now(),
    );

    let permissionSourceChannelId: string | null = null;
    let permissionChannel = scopedChannel;
    const isThread = scopedChannel ? THREAD_TYPES.has(scopedChannel.type) : false;
    if (guildOwner) {
      effective = applyPermissions(
        trace,
        'guild_owner',
        effective,
        ALL_KNOWN_PERMISSIONS,
        0n,
        'Guild ownership grants every known permission and bypasses channel overwrites.',
      );
    } else if (administrator) {
      effective = applyPermissions(
        trace,
        'administrator',
        effective,
        ALL_KNOWN_PERMISSIONS,
        0n,
        'ADMINISTRATOR grants every known permission and bypasses channel overwrites.',
      );
    } else if (scopedChannel) {
      if (isThread) {
        if (!scopedChannel.parent_id) {
          warnings.push('Thread payload omitted parent_id, so inherited permissions are unknown.');
          permissionEvidenceComplete = false;
          permissionChannel = null;
        } else {
          permissionChannel = (await container.rest.get(
            Routes.channel(scopedChannel.parent_id),
          )) as RawChannel;
          if (permissionChannel.guild_id !== args.guild_id) {
            fail('channel_id', 'The thread parent does not belong to guild_id.');
          }
        }
      }
      if (permissionChannel) {
        permissionSourceChannelId = permissionChannel.id;
        if (permissionChannel.permission_overwrites === undefined) {
          permissionEvidenceComplete = false;
          warnings.push(
            'Channel payload omitted permission_overwrites, so channel permissions are incomplete.',
          );
        }
        const overwrites = permissionChannel.permission_overwrites ?? [];
        const everyoneOverwrite = overwrites.find(
          (overwrite) => overwrite.type === OverwriteType.Role && overwrite.id === args.guild_id,
        );
        const everyoneAllow = BigInt(everyoneOverwrite?.allow ?? '0');
        const everyoneDeny = BigInt(everyoneOverwrite?.deny ?? '0');
        observedPermissions |= everyoneAllow | everyoneDeny;
        effective = applyPermissions(
          trace,
          'channel_everyone',
          effective,
          everyoneAllow,
          everyoneDeny,
          'Apply the channel @everyone overwrite: deny first, then allow.',
        );

        let roleAllow = 0n;
        let roleDeny = 0n;
        for (const roleId of actorRoleIds) {
          if (roleId === args.guild_id) continue;
          const overwrite = overwrites.find(
            (candidate) => candidate.type === OverwriteType.Role && candidate.id === roleId,
          );
          if (!overwrite) continue;
          roleAllow |= BigInt(overwrite.allow);
          roleDeny |= BigInt(overwrite.deny);
        }
        observedPermissions |= roleAllow | roleDeny;
        effective = applyPermissions(
          trace,
          'channel_roles',
          effective,
          roleAllow,
          roleDeny,
          'Combine every subject-role overwrite, then apply deny before allow.',
        );

        if (hasUser) {
          const memberOverwrite = overwrites.find(
            (overwrite) => overwrite.type === OverwriteType.Member && overwrite.id === args.user_id,
          );
          const memberAllow = BigInt(memberOverwrite?.allow ?? '0');
          const memberDeny = BigInt(memberOverwrite?.deny ?? '0');
          observedPermissions |= memberAllow | memberDeny;
          effective = applyPermissions(
            trace,
            'channel_member',
            effective,
            memberAllow,
            memberDeny,
            'Apply the member-specific overwrite last: deny before allow.',
          );
        }
      }
    }

    if (subjectTimedOut && !guildOwner && !administrator) {
      const timeoutPermissions =
        PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
      effective = applyPermissions(
        trace,
        'member_timeout',
        effective,
        0n,
        effective & ~timeoutPermissions,
        'An active timeout leaves only VIEW_CHANNEL and READ_MESSAGE_HISTORY effective.',
      );
    }

    const requested = [
      ...(args.action ? permissionsForAction(args.action, isThread) : []),
      ...(args.requested_permissions ?? []),
    ];
    const requestedPermissions = [...new Set(requested)];
    const invalidPermissions = requestedPermissions.filter(
      (name) => !PERMISSIONS_BY_NAME.has(name),
    );
    if (invalidPermissions.length > 0) {
      fail(
        'requested_permissions',
        `Unknown Discord permission name(s): ${invalidPermissions.join(', ')}.`,
      );
    }
    const missingPermissions = requestedPermissions.filter((name) => {
      const bit = PERMISSIONS_BY_NAME.get(name) as bigint;
      return (effective & bit) !== bit;
    });
    const implicitDenies = scopedChannel
      ? requestedPermissions
          .filter((name) => !missingPermissions.includes(name))
          .map((name) => ({
            permission: name,
            missing_prerequisites: missingPrerequisites(name, effective, scopedChannel.type),
          }))
          .filter(({ missing_prerequisites }) => missing_prerequisites.length > 0)
          .map(({ permission, missing_prerequisites }) => ({
            permission,
            missing_prerequisites,
            reason: `Missing prerequisite permission(s): ${missing_prerequisites.join(', ')}.`,
          }))
      : [];
    const ineffectivePermissions = implicitDenies.map(({ permission }) => permission);

    const hierarchy = evaluateHierarchy({
      action: args.action,
      actorId: args.user_id,
      actorRoleIds,
      actorIsOwner: guildOwner,
      targetMember,
      targetRole: targetRole ?? null,
      guildOwnerId: guild.owner_id,
      everyoneRole: everyone,
      rolesById,
      missingActorRoleIds,
      missingTargetRoleIds,
    });
    const privateThreadMembershipUnknown =
      scopedChannel?.type === ChannelType.PrivateThread &&
      !guildOwner &&
      !administrator &&
      (effective & PermissionFlagsBits.ManageThreads) === 0n &&
      requestedPermissions.some(
        (name) => name === 'VIEW_CHANNEL' || CHANNEL_SCOPED_PERMISSIONS.has(name),
      );
    const confidence: 'complete' | 'partial' =
      !permissionEvidenceComplete ||
      missingTargetRoleIds.length > 0 ||
      (scopedChannel !== null && permissionChannel === null) ||
      hierarchy.status === 'unknown' ||
      privateThreadMembershipUnknown
        ? 'partial'
        : 'complete';

    if (privateThreadMembershipUnknown) {
      warnings.push(
        'Discord did not expose private-thread membership for this subject; channel bits alone cannot prove access.',
      );
    }

    const permissionDenied = missingPermissions.length > 0 || ineffectivePermissions.length > 0;
    const allowed =
      hierarchy.status === 'denied' || (permissionEvidenceComplete && permissionDenied)
        ? false
        : confidence === 'partial'
          ? null
          : true;
    const unknownPermissionBits = observedPermissions & ~ALL_KNOWN_PERMISSIONS;
    if (unknownPermissionBits !== 0n) {
      warnings.push(
        `Discord returned permission bits unknown to this build: ${unknownPermissionBits.toString()}.`,
      );
    }

    const subjectId = (args.user_id ?? args.role_id) as string;
    const status = allowed === null ? 'UNKNOWN' : allowed ? 'ALLOWED' : 'DENIED';
    return dualResult({
      text: [
        `**Permission result: ${status}**`,
        `Subject: \`${hasUser ? 'user' : 'role'}:${subjectId}\``,
        `Scope: ${args.channel_id ? `\`channel:${args.channel_id}\`` : `\`guild:${args.guild_id}\``}`,
        `Requested: ${requestedPermissions.join(', ')}`,
        `Missing: ${missingPermissions.join(', ') || '_(none)_'}`,
        `Ineffective: ${ineffectivePermissions.join(', ') || '_(none)_'}`,
        `Hierarchy: ${hierarchy.status} - ${hierarchy.reason}`,
        ...(warnings.length > 0 ? [`Warnings: ${warnings.join(' ')}`] : []),
      ].join('\n'),
      data: {
        guild_id: args.guild_id,
        channel_id: args.channel_id ?? null,
        permission_source_channel_id: permissionSourceChannelId,
        subject_type: hasUser ? ('member' as const) : ('role' as const),
        subject_id: subjectId,
        action: args.action ?? null,
        requested_permissions: requestedPermissions,
        allowed,
        base_permissions: basePermissions.toString(),
        effective_permissions: effective.toString(),
        unknown_permission_bits: unknownPermissionBits.toString(),
        missing_permissions: missingPermissions,
        ineffective_permissions: ineffectivePermissions,
        implicit_denies: implicitDenies,
        administrator,
        guild_owner: guildOwner,
        subject_timed_out: subjectTimedOut,
        applied_role_ids: [args.guild_id, ...resolvedActorRoles.map((role) => role.id)],
        decision_trace: trace,
        role_hierarchy_check: hierarchy,
        warnings,
        confidence,
      },
    });
  },
});
