import { PermissionFlagsBits } from 'discord-api-types/v10';
import {
  ALL_KNOWN_PERMISSION_BITS,
  applyPermissionBits,
  combineRoleOverwriteBits,
  compareRoles,
  indexPermissionOverwrites,
  type RawChannel,
  type RawRole,
} from '../tools/permissions/_lib/evaluator.js';

export interface BotMemberSnapshot {
  readonly id: string;
  readonly roles: readonly string[];
}

export type BotRoleSnapshot = RawRole;
export type BotChannelSnapshot = RawChannel;

export interface BotPermissionEvaluation {
  readonly basePermissions: bigint;
  readonly effectivePermissions: bigint;
  readonly unknownPermissionBits: bigint;
  readonly missingRoleIds: readonly string[];
  readonly permissionSourceChannelId: string | null;
  readonly administrator: boolean;
  readonly guildOwner: boolean;
  readonly topRoleId: string;
  readonly confidence: 'complete' | 'partial';
}

/**
 * Evaluate the permissions that an authenticated bot can prove for one guild.
 *
 * This is deliberately a pure function. It does not fetch Discord, infer
 * missing roles, or decide whether an individual tool is safe. Callers can
 * use the result for a doctor/preflight report and keep `unknown` separate
 * from `denied` when Discord did not return enough evidence.
 */
export function evaluateBotPermissions(options: {
  readonly guildId: string;
  readonly guildOwnerId?: string;
  readonly roles: readonly BotRoleSnapshot[];
  readonly member: BotMemberSnapshot;
  readonly channel?: BotChannelSnapshot;
}): BotPermissionEvaluation {
  const rolesById = new Map(options.roles.map((role) => [role.id, role]));
  const everyone = rolesById.get(options.guildId);
  if (everyone === undefined) {
    throw new Error(`Discord guild roles did not include the @everyone role ${options.guildId}`);
  }

  const missingRoleIds: string[] = [];
  let observedPermissions = BigInt(everyone.permissions);
  let basePermissions = BigInt(everyone.permissions);
  const resolvedRoles: RawRole[] = [];
  for (const roleId of options.member.roles) {
    if (roleId === options.guildId) continue;
    const role = rolesById.get(roleId);
    if (role === undefined) {
      missingRoleIds.push(roleId);
      continue;
    }
    resolvedRoles.push(role);
    const permissions = BigInt(role.permissions);
    basePermissions |= permissions;
    observedPermissions |= permissions;
  }

  const guildOwner =
    options.guildOwnerId !== undefined && options.member.id === options.guildOwnerId;
  const administrator = (basePermissions & PermissionFlagsBits.Administrator) !== 0n;
  let effectivePermissions = basePermissions;
  let permissionSourceChannelId: string | null = null;
  let complete = missingRoleIds.length === 0;

  if (guildOwner || administrator) {
    effectivePermissions = ALL_KNOWN_PERMISSION_BITS;
  } else if (options.channel !== undefined) {
    permissionSourceChannelId = options.channel.id;
    if (options.channel.permission_overwrites === undefined) {
      complete = false;
    } else {
      const overwriteIndex = indexPermissionOverwrites(options.channel.permission_overwrites);
      observedPermissions |= overwriteIndex.observed;
      const everyoneOverwrite = overwriteIndex.roles.get(options.guildId);
      effectivePermissions = applyPermissionBits(
        effectivePermissions,
        everyoneOverwrite?.allow ?? 0n,
        everyoneOverwrite?.deny ?? 0n,
      );
      const roleOverwrites = combineRoleOverwriteBits(overwriteIndex, [
        options.guildId,
        ...resolvedRoles.map((role) => role.id),
      ]);
      effectivePermissions = applyPermissionBits(
        effectivePermissions,
        roleOverwrites.allow,
        roleOverwrites.deny,
      );
      const memberOverwrite = overwriteIndex.members.get(options.member.id);
      effectivePermissions = applyPermissionBits(
        effectivePermissions,
        memberOverwrite?.allow ?? 0n,
        memberOverwrite?.deny ?? 0n,
      );
    }
  }

  const topRole = resolvedRoles.reduce(
    (highest, role) => (compareRoles(role, highest) > 0 ? role : highest),
    everyone,
  );
  const unknownPermissionBits = observedPermissions & ~ALL_KNOWN_PERMISSION_BITS;

  return {
    basePermissions,
    effectivePermissions,
    unknownPermissionBits,
    missingRoleIds,
    permissionSourceChannelId,
    administrator,
    guildOwner,
    topRoleId: topRole.id,
    confidence: complete && unknownPermissionBits === 0n ? 'complete' : 'partial',
  };
}
