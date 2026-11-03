import type { REST } from '@discordjs/rest';
import { ChannelType, PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import {
  applyPermissionBits,
  combineRoleOverwriteBits,
  indexPermissionOverwrites,
  type RawOverwrite,
  type RawRole,
} from '../permissions/_lib/evaluator.js';

/** The channel fields channel visibility needs; extra fields pass through. */
export interface VisibilityChannel {
  readonly id: string;
  readonly type: number;
  readonly parent_id?: string | null;
  readonly permission_overwrites?: readonly RawOverwrite[];
}

interface RawMember {
  readonly roles?: readonly string[];
}

interface RawGuild {
  readonly owner_id?: string;
}

interface CallerContext {
  readonly guildId: string;
  readonly roleIds: readonly string[];
  readonly base: bigint;
  /** Guild owner or ADMINISTRATOR: every channel, regardless of overwrites. */
  readonly bypass: boolean;
}

const CATEGORY = ChannelType.GuildCategory;
const PRIVATE_THREAD = ChannelType.PrivateThread;

/**
 * Resolve the acting caller's guild-level permission base.
 *
 * Returns null when Discord did not return enough to reason about visibility
 * (missing @everyone role, unknown member roles). Callers must then hide the
 * channel rather than disclose it.
 */
async function readCallerContext(
  rest: REST,
  guildId: string,
  callerId: string,
  signal?: AbortSignal,
): Promise<CallerContext | null> {
  const [guild, member, roles] = (await Promise.all([
    rest.get(Routes.guild(guildId), { signal }),
    rest.get(Routes.guildMember(guildId, callerId), { signal }),
    rest.get(Routes.guildRoles(guildId), { signal }),
  ])) as [RawGuild, RawMember, RawRole[]];

  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const everyone = rolesById.get(guildId);
  if (everyone === undefined) return null;

  // A member payload without a roles array is a partial/404 body, not proof
  // that the caller holds nothing; treat it as unresolvable.
  if (!Array.isArray(member.roles)) return null;
  const roleIds = member.roles.filter((id) => id !== guildId);
  if (roleIds.some((id) => !rolesById.has(id))) return null;

  let base = BigInt(everyone.permissions);
  for (const id of roleIds) base |= BigInt(rolesById.get(id)!.permissions);

  return {
    guildId,
    roleIds,
    base,
    bypass: guild.owner_id === callerId || (base & PermissionFlagsBits.Administrator) !== 0n,
  };
}

/**
 * A thread carries its own overwrites only when Discord serialized them; its
 * access otherwise follows the parent exactly. Guild channels always carry the
 * field, so its absence there means the payload is incomplete.
 */
function isVisible(
  context: CallerContext,
  callerId: string,
  channel: VisibilityChannel,
  category: VisibilityChannel | undefined,
  inheritWhenUnspecified = false,
): boolean {
  if (context.bypass) return true;
  let effective = context.base;
  for (const scope of [category, channel]) {
    if (scope === undefined) continue;
    if (scope.permission_overwrites === undefined) {
      if (inheritWhenUnspecified) continue;
      // Discord omits overwrites only when it cannot serialize them; without
      // them the deny/allow set is unknown, so the channel stays hidden.
      return false;
    }
    const index = indexPermissionOverwrites(scope.permission_overwrites);
    const everyone = index.roles.get(context.guildId);
    effective = applyPermissionBits(effective, everyone?.allow ?? 0n, everyone?.deny ?? 0n);
    const roles = combineRoleOverwriteBits(index, context.roleIds);
    effective = applyPermissionBits(effective, roles.allow, roles.deny);
    const member = index.members.get(callerId);
    effective = applyPermissionBits(effective, member?.allow ?? 0n, member?.deny ?? 0n);
  }
  const view = PermissionFlagsBits.ViewChannel;
  if ((effective & view) !== view) return false;
  // Private-thread membership is not exposed by the guild channel listing.
  // Without MANAGE_THREADS the caller's membership cannot be proven, so the
  // thread name stays hidden rather than guessed.
  if (channel.type === PRIVATE_THREAD && (effective & PermissionFlagsBits.ManageThreads) === 0n)
    return false;
  return true;
}

/**
 * Keep only the channels the acting Discord user may view.
 *
 * Guild-scoped routes such as `GET /guilds/{id}/channels` are authorized by the
 * bot credential, so an OAuth2 caller without `VIEW_CHANNEL` still receives
 * every channel name. Tools that enumerate guild channels must pass their
 * result through here, or they disclose names the caller cannot see.
 *
 * `callerId` being absent means no end user is acting (bot/stdio), where the
 * credential's own view already bounds the response.
 */
export async function filterCallerVisibleChannels<T extends VisibilityChannel>(
  rest: REST,
  guildId: string,
  channels: readonly T[],
  callerId: string | undefined,
  signal?: AbortSignal,
): Promise<T[]> {
  if (callerId === undefined) return [...channels];
  const context = await readCallerContext(rest, guildId, callerId, signal);
  if (context === null) return [];
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return channels.filter((channel) => {
    const parent = channel.parent_id ? byId.get(channel.parent_id) : undefined;
    const category = parent?.type === CATEGORY ? parent : undefined;
    return isVisible(context, callerId, channel, category);
  });
}

/**
 * Keep only the threads whose parent channel and own overwrites the acting
 * caller may view. Threads whose parent cannot be read are dropped rather than
 * assumed visible.
 */
export async function filterCallerVisibleThreads<T extends VisibilityChannel>(
  rest: REST,
  threads: readonly T[],
  callerId: string | undefined,
  signal?: AbortSignal,
): Promise<T[]> {
  if (callerId === undefined) return [...threads];

  const loaded = new Map<string, VisibilityChannel & { guild_id?: string }>();
  const load = async (channelId: string): Promise<void> => {
    if (loaded.has(channelId)) return;
    try {
      const raw = (await rest.get(Routes.channel(channelId), { signal })) as
        | (VisibilityChannel & { guild_id?: string })
        | undefined;
      if (raw !== undefined) loaded.set(channelId, raw);
    } catch (error) {
      if (signal?.aborted) throw error;
      // An unreadable channel proves nothing about a thread's visibility.
    }
  };

  const contexts = new Map<string, CallerContext | null>();
  const visible: T[] = [];
  for (const thread of threads) {
    const parentId = thread.parent_id ?? '';
    if (parentId === '') continue;
    await load(parentId);
    const parent = loaded.get(parentId);
    if (parent?.guild_id === undefined) continue;
    if (!contexts.has(parent.guild_id)) {
      contexts.set(
        parent.guild_id,
        await readCallerContext(rest, parent.guild_id, callerId, signal),
      );
    }
    const context = contexts.get(parent.guild_id) ?? null;
    if (context === null) continue;
    // The parent's own category supplies the inherited overwrite layer.
    let category: VisibilityChannel | undefined;
    if (parent.parent_id !== null && parent.parent_id !== undefined) {
      await load(parent.parent_id);
      const owner = loaded.get(parent.parent_id);
      if (owner?.type === CATEGORY) category = owner;
    }
    if (!isVisible(context, callerId, parent, category)) continue;
    // Thread membership is not exposed by the guild listing, and a thread's own
    // overwrites refine what its parent already grants - both are judged on the
    // thread record, not only when it happens to carry overwrites.
    // A public thread with no overwrites inherits its parent's access, which
    // was already proven above; a private thread additionally needs membership
    // (approximated by MANAGE_THREADS, the only signal the listing exposes).
    if (!isVisible(context, callerId, thread, undefined, true)) continue;
    visible.push(thread);
  }
  return visible;
}
