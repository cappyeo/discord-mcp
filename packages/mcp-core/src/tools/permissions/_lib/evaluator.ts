import { OverwriteType, PermissionFlagsBits } from 'discord-api-types/v10';

export const ALL_KNOWN_PERMISSION_BITS = Object.values(PermissionFlagsBits).reduce(
  (mask, permission) => mask | permission,
  0n,
);

export interface RawRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
}

export interface RawOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface RawChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  permission_overwrites?: RawOverwrite[];
}

export interface PermissionBits {
  allow: bigint;
  deny: bigint;
}

export interface PermissionOverwriteIndex {
  roles: ReadonlyMap<string, PermissionBits>;
  members: ReadonlyMap<string, PermissionBits>;
  observed: bigint;
}

export function applyPermissionBits(before: bigint, allow: bigint, deny: bigint): bigint {
  return (before & ~deny) | allow;
}

export function indexPermissionOverwrites(
  overwrites: readonly RawOverwrite[],
): PermissionOverwriteIndex {
  const roles = new Map<string, PermissionBits>();
  const members = new Map<string, PermissionBits>();
  let observed = 0n;

  for (const overwrite of overwrites) {
    const bits = { allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) };
    observed |= bits.allow | bits.deny;
    if (overwrite.type === OverwriteType.Role) roles.set(overwrite.id, bits);
    if (overwrite.type === OverwriteType.Member) members.set(overwrite.id, bits);
  }

  return { roles, members, observed };
}

export function combineRoleOverwriteBits(
  index: PermissionOverwriteIndex,
  roleIds: readonly string[],
): PermissionBits {
  let allow = 0n;
  let deny = 0n;
  for (const roleId of roleIds) {
    const overwrite = index.roles.get(roleId);
    if (!overwrite) continue;
    allow |= overwrite.allow;
    deny |= overwrite.deny;
  }
  return { allow, deny };
}

export function compareRoles(left: RawRole, right: RawRole): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.id === right.id) return 0;
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}
