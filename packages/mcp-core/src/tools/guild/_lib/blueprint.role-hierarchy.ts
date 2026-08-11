/** Discord orders roles by position, then by snowflake age for ties. */
export function compareDiscordRoles(
  left: { readonly id: string; readonly position: number },
  right: { readonly id: string; readonly position: number },
): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.id === right.id) return 0;
  // For equal positions, the older (smaller) snowflake is higher.
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

export function isDiscordRoleStrictlyBelow(
  role: { readonly id: string; readonly position: number },
  botTopRole: { readonly id: string; readonly position: number },
): boolean {
  return compareDiscordRoles(role, botTopRole) < 0;
}
