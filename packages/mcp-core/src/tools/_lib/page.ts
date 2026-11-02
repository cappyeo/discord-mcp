/** Reject malformed provider pages before callers advance a checkpoint. */
export function validatePage(ids: string[], limit: number, before?: string, after?: string): void {
  if (ids.length > limit) throw new Error('Discord page exceeded its requested limit');
  const seen = new Set<string>();
  for (const id of ids) {
    if (
      !/^\d{17,20}$/.test(id) ||
      BigInt(id) > 18446744073709551615n ||
      seen.has(id) ||
      (before !== undefined && BigInt(id) >= BigInt(before)) ||
      (after !== undefined && BigInt(id) <= BigInt(after))
    )
      throw new Error('Discord page contains invalid, duplicate or nonadvancing IDs');
    seen.add(id);
  }
}
export function compareIds(a: string, b: string): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
