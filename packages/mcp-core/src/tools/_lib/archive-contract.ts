import { compareIds, validatePage } from './page.js';

interface Thread {
  id: string;
  parent_id?: string | null;
  guild_id?: string;
  thread_metadata?: { archive_timestamp?: string };
}
export function archivePageContract<T extends Thread>(
  raw: { threads: T[]; has_more?: boolean },
  parent: string,
  limit: number,
  before: string | undefined,
  joined: boolean,
  allowedGuilds?: readonly string[],
): { threads: T[]; has_more: boolean; next_before?: string; complete: boolean } {
  if (!Array.isArray(raw.threads) || typeof raw.has_more !== 'boolean')
    throw new Error('Invalid Discord archive page');
  const fetchLimit = joined ? limit : Math.min(limit + 1, 100);
  validatePage(
    raw.threads.map((t) => t.id),
    fetchLimit,
    joined ? before : undefined,
  );
  if (
    raw.threads.some(
      (t) =>
        (t.parent_id !== undefined && t.parent_id !== parent) ||
        (allowedGuilds !== undefined &&
          t.guild_id !== undefined &&
          !allowedGuilds.includes(t.guild_id)),
    )
  )
    throw new Error('Discord archive thread scope mismatch');
  if (raw.has_more && raw.threads.length === 0) throw new Error('Archive continuation has no rows');
  // Discord emits microseconds; Date.parse alone would silently collapse them.
  const timeKey = (value: string): bigint => {
    const match = value.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/,
    );
    const milliseconds = match === null ? NaN : Date.parse(`${match[1]}${match[3]}`);
    if (!Number.isFinite(milliseconds)) throw new Error('Archive response lacks a valid timestamp');
    return BigInt(milliseconds) * 1_000_000n + BigInt((match![2] ?? '').padEnd(9, '0'));
  };
  const timestamp = (t: T) => timeKey(t.thread_metadata?.archive_timestamp ?? '');
  if (joined) raw = { ...raw, threads: [...raw.threads].sort((a, b) => compareIds(b.id, a.id)) };
  let emit = Math.min(limit, raw.threads.length);
  if (!joined) {
    for (let n = 0; n < raw.threads.length; n++) {
      const time = timestamp(raw.threads[n]!);
      if (
        (n > 0 && time > timestamp(raw.threads[n - 1]!)) ||
        (before !== undefined && !(time < timeKey(before)))
      )
        throw new Error('Archive timestamps did not advance');
    }
    if ((raw.has_more || raw.threads.length > emit) && emit > 0) {
      const boundary = timestamp(raw.threads[emit - 1]!);
      if (emit === raw.threads.length || timestamp(raw.threads[emit]!) === boundary) {
        while (emit > 0 && timestamp(raw.threads[emit - 1]!) === boundary) emit--;
        if (emit === 0)
          throw new Error(
            'Archive timestamp group cannot be safely paged; increase limit up to 100. More than 100 tied threads requires another verified discovery path',
          );
      }
    }
  }
  const threads = raw.threads.slice(0, emit);
  const more = raw.has_more || emit < raw.threads.length;
  const last = threads.at(-1);
  return {
    threads,
    has_more: more,
    complete: !more,
    ...(more && last !== undefined
      ? { next_before: joined ? last.id : last.thread_metadata!.archive_timestamp! }
      : {}),
  };
}
