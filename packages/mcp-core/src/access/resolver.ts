import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import {
  type BotChannelSnapshot,
  type BotMemberSnapshot,
  type BotRoleSnapshot,
  evaluateBotPermissions,
} from './evaluator.js';
import type { DiscordAccessRequirement, GatewayIntentName } from './requirements.js';
import type {
  HierarchyEvidenceStatus,
  RuntimeAccessEvidence,
  RuntimeAccessRequest,
  RuntimeAccessResolver,
} from './runtime.js';

const SNOWFLAKE_RE = /^\d{17,20}$/u;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_024;
const MAX_CACHE_TTL_MS = 60_000;
const CHANNEL_FIELDS = [
  'channel_id',
  'thread_id',
  'webhook_channel_id',
  'parent_id',
  'afk_channel_id',
  'system_channel_id',
  'rules_channel_id',
  'public_updates_channel_id',
  'safety_alerts_channel_id',
] as const;
const CHANNEL_ARRAY_FIELDS = ['default_channel_ids'] as const;

type RuntimeIntentState = 'approved' | 'missing' | 'unknown';

export interface RuntimeAccessResolverOptions {
  readonly rest: REST;
  /** Optional operator lock. The resolver still verifies that `/users/@me` is a bot. */
  readonly expectedBotId?: string;
  /** The intents actually requested by this Gateway runtime, not application approval flags. */
  readonly runtimeIntents?: Readonly<Partial<Record<GatewayIntentName, RuntimeIntentState>>>;
  /** Short cache for read-only permission snapshots. Defaults to five seconds. */
  readonly cacheTtlMs?: number;
  /** Maximum number of identity/guild/channel snapshots retained in memory. */
  readonly maxCacheEntries?: number;
}

export type RuntimeAccessResolverHandle = RuntimeAccessResolver & {
  /** Drop all cached evidence after a permission or role mutation. */
  invalidate: () => void;
};

interface RawUser {
  readonly id?: unknown;
  readonly bot?: unknown;
}

interface RawApplication {
  readonly id?: unknown;
  readonly bot?: unknown;
}

interface RawSku {
  readonly id?: unknown;
  readonly application_id?: unknown;
}

interface RawWebhook {
  readonly id?: unknown;
  readonly channel_id?: unknown;
  readonly guild_id?: unknown;
}

interface RawInvite {
  readonly guild?: unknown;
}

interface IdentitySnapshot {
  readonly id: string;
}

interface GuildSnapshot {
  readonly id: string;
  readonly ownerId?: string;
  readonly member: BotMemberSnapshot;
  readonly roles: readonly BotRoleSnapshot[];
}

interface ChannelSnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly permissionOverwrites?: BotChannelSnapshot['permission_overwrites'];
}

interface ResolvedChannelTarget {
  readonly fields: readonly string[];
  readonly target: ChannelSnapshot;
  readonly permissionChannel: BotChannelSnapshot;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: unknown;
}

interface PendingEntry {
  readonly generation: number;
  readonly promise: Promise<unknown>;
}

interface ResolverContext {
  readonly identity: IdentitySnapshot;
  readonly runtimeIntents: Readonly<Partial<Record<GatewayIntentName, RuntimeIntentState>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) {
    throw new Error(`Discord returned an invalid ${label}`);
  }
  return value;
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return id(value, label);
}

function stringArg(args: unknown, field: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[field];
  return typeof value === 'string' && SNOWFLAKE_RE.test(value) ? value : undefined;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Discord returned an invalid ${label}`);
  }
  return value;
}

function bitfield(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new Error(`Discord returned an invalid ${label} permission bitfield`);
  }
  return value;
}

function parseMember(value: unknown, expectedId: string): BotMemberSnapshot {
  if (!isRecord(value) || !Array.isArray(value.roles)) {
    throw new Error('Discord returned a malformed guild bot member');
  }
  const user = isRecord(value.user) ? value.user : value;
  const memberId = id(user.id, 'guild bot member ID');
  if (memberId !== expectedId) {
    throw new Error('Discord returned a different guild member than the bot');
  }
  return {
    id: memberId,
    roles: value.roles.map((roleId) => id(roleId, 'guild member role ID')),
  };
}

function parseRole(value: unknown): BotRoleSnapshot {
  if (!isRecord(value)) throw new Error('Discord returned a malformed guild role');
  if (typeof value.name !== 'string' || typeof value.managed !== 'boolean') {
    throw new Error('Discord returned a malformed guild role');
  }
  return {
    id: id(value.id, 'role ID'),
    name: value.name,
    position: integer(value.position, 'role position'),
    permissions: bitfield(value.permissions, 'role'),
    managed: value.managed,
  };
}

function parseRoles(value: unknown): BotRoleSnapshot[] {
  if (!Array.isArray(value)) throw new Error('Discord returned a malformed guild role list');
  return value.map(parseRole);
}

function parseOverwrite(
  value: unknown,
): NonNullable<BotChannelSnapshot['permission_overwrites']>[number] {
  if (!isRecord(value))
    throw new Error('Discord returned a malformed channel permission overwrite');
  return {
    id: id(value.id, 'permission overwrite ID'),
    type: integer(value.type, 'permission overwrite type'),
    allow: bitfield(value.allow, 'overwrite allow'),
    deny: bitfield(value.deny, 'overwrite deny'),
  };
}

function parseChannel(value: unknown, expectedId: string): ChannelSnapshot {
  if (!isRecord(value)) throw new Error('Discord returned a malformed channel');
  const channelId = id(value.id, 'channel ID');
  if (channelId !== expectedId)
    throw new Error('Discord returned a different channel than requested');
  const guildId = id(value.guild_id, 'channel guild ID');
  const type = integer(value.type, 'channel type');
  let permissionOverwrites: BotChannelSnapshot['permission_overwrites'] | undefined;
  if (value.permission_overwrites !== undefined) {
    if (!Array.isArray(value.permission_overwrites)) {
      throw new Error('Discord returned malformed channel permission overwrites');
    }
    permissionOverwrites = value.permission_overwrites.map(parseOverwrite);
  }
  return {
    id: channelId,
    guildId,
    type,
    parentId: optionalId(value.parent_id, 'channel parent ID') ?? null,
    ...(permissionOverwrites === undefined ? {} : { permissionOverwrites }),
  };
}

function parseGuild(value: unknown, expectedId: string): { id: string; ownerId?: string } {
  if (!isRecord(value)) throw new Error('Discord returned a malformed guild');
  const guildId = id(value.id, 'guild ID');
  if (guildId !== expectedId) throw new Error('Discord returned a different guild than requested');
  const ownerId = optionalId(value.owner_id, 'guild owner ID');
  return ownerId === undefined ? { id: guildId } : { id: guildId, ownerId };
}

function parseIdentity(value: unknown): IdentitySnapshot {
  if (!isRecord(value) || value.bot !== true) {
    throw new Error('Discord identity verification did not return a bot account');
  }
  return { id: id(value.id, 'bot ID') };
}

function parseApplication(value: unknown, expectedBotId: string): string {
  if (!isRecord(value)) throw new Error('Discord returned a malformed application');
  const applicationId = id(value.id, 'application ID');
  if (applicationId !== expectedBotId) {
    throw new Error('Discord application identity did not match the authenticated bot');
  }
  if (value.bot !== undefined && value.bot !== null) {
    if (!isRecord(value.bot) || id(value.bot.id, 'application bot ID') !== expectedBotId) {
      throw new Error('Discord application bot identity did not match the authenticated bot');
    }
  }
  return applicationId;
}

function asRecord(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function normalizeTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CACHE_TTL_MS;
  return Math.min(MAX_CACHE_TTL_MS, Math.max(0, Math.floor(value)));
}

function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CACHE_ENTRIES;
  return Math.max(16, Math.min(DEFAULT_MAX_CACHE_ENTRIES, Math.floor(value)));
}

/**
 * Build a conservative, read-only REST evidence provider for the runtime
 * access middleware. It never mutates Discord and returns no raw Discord
 * payloads. Unknown/partial responses are deliberately represented as
 * incomplete evidence so `MCP_ACCESS_MODE=enforce` can fail closed.
 */
export function createRuntimeAccessResolver(
  options: RuntimeAccessResolverOptions,
): RuntimeAccessResolverHandle {
  const ttlMs = normalizeTtl(options.cacheTtlMs);
  const maxEntries = normalizeMaxEntries(options.maxCacheEntries);
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, PendingEntry>();
  let generation = 0;
  const runtimeIntents = options.runtimeIntents ?? {};

  const invalidate = (): void => {
    // A request already in flight may complete after invalidation. Its result
    // must not repopulate the cache with pre-mutation evidence.
    generation += 1;
    cache.clear();
  };

  const cached = async <T>(
    key: string,
    loader: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (hit.expiresAt > now) return withAbort(Promise.resolve(hit.value as T), signal);
      cache.delete(key);
    }
    const currentGeneration = generation;
    let flight = pending.get(key);
    if (flight === undefined || flight.generation !== currentGeneration) {
      const promise = loader()
        .then((value) => {
          if (ttlMs > 0 && currentGeneration === generation) {
            if (cache.size >= maxEntries) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(key, { expiresAt: Date.now() + ttlMs, value });
          }
          return value;
        })
        .finally(() => {
          if (pending.get(key)?.promise === promise) pending.delete(key);
        });
      flight = { generation: currentGeneration, promise };
      pending.set(key, flight);
    }
    return withAbort(flight.promise as Promise<T>, signal);
  };

  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
    (await options.rest.get(
      path as `/${string}`,
      signal === undefined ? undefined : { signal },
    )) as T;

  const readIdentity = (signal?: AbortSignal): Promise<IdentitySnapshot> =>
    cached(
      'identity',
      async () => parseIdentity(await get<RawUser>(Routes.user('@me'), signal)),
      signal,
    );

  const readGuild = async (
    guildId: string,
    botId: string,
    signal?: AbortSignal,
  ): Promise<GuildSnapshot> =>
    cached(
      `guild:${guildId}:${botId}`,
      async () => {
        const [guildRaw, memberRaw, rolesRaw] = await Promise.all([
          get<unknown>(Routes.guild(guildId), signal),
          get<unknown>(Routes.guildMember(guildId, botId), signal),
          get<unknown>(Routes.guildRoles(guildId), signal),
        ]);
        const guild = parseGuild(guildRaw, guildId);
        return {
          ...guild,
          member: parseMember(memberRaw, botId),
          roles: parseRoles(rolesRaw),
        };
      },
      signal,
    );

  const readChannel = (channelId: string, signal?: AbortSignal): Promise<ChannelSnapshot> =>
    cached(
      `channel:${channelId}`,
      async () => parseChannel(await get(Routes.channel(channelId), signal), channelId),
      signal,
    );

  const resolveWebhookChannel = async (
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const input = asRecord(args);
    if (typeof input.webhook_id !== 'string' || !SNOWFLAKE_RE.test(input.webhook_id)) {
      return undefined;
    }
    const token =
      typeof input.token === 'string' && input.token.length > 0 ? input.token : undefined;
    const raw = await get<RawWebhook>(
      Routes.webhook(input.webhook_id, token) as `/${string}`,
      signal,
    );
    if (raw.id !== undefined) id(raw.id, 'webhook ID');
    const channelId = optionalId(raw.channel_id, 'webhook channel ID');
    if (channelId === undefined) {
      // A DM webhook has no guild channel and cannot satisfy a channel-scoped
      // bot permission contract.
      return undefined;
    }
    return channelId;
  };

  const resolveInviteGuild = async (
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const input = asRecord(args);
    if (typeof input.code !== 'string' || input.code.length === 0) return undefined;
    const raw = await get<RawInvite>(Routes.invite(input.code), signal);
    if (!isRecord(raw.guild)) return undefined;
    return optionalId(raw.guild.id, 'invite guild ID');
  };

  const resolveChannelById = async (
    channelId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly target: ChannelSnapshot;
    readonly permissionChannel: BotChannelSnapshot;
  }> => {
    const target = await readChannel(channelId, signal);
    let permissionOverwrites = target.permissionOverwrites;
    if (permissionOverwrites === undefined && target.parentId !== null) {
      const parent = await readChannel(target.parentId, signal);
      if (parent.guildId !== target.guildId) {
        throw new Error('channel parent belongs to a different guild');
      }
      permissionOverwrites = parent.permissionOverwrites;
    }
    return {
      target,
      permissionChannel: {
        id: target.id,
        type: target.type,
        guild_id: target.guildId,
        ...(permissionOverwrites === undefined
          ? {}
          : { permission_overwrites: permissionOverwrites }),
      },
    };
  };

  /**
   * Resolve every channel-shaped target in a payload. The first target is not
   * authoritative when a route carries two channels (for example an
   * announcement source and a follower destination): every target must be
   * resolved before permission evidence can be trusted. Cross-guild routes
   * must opt in explicitly through their access contract.
   */
  const resolveChannels = async (
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<ResolvedChannelTarget>> => {
    const input = asRecord(args);
    const channelFields = new Map<string, string[]>();
    for (const field of CHANNEL_FIELDS) {
      const value = input[field];
      // Several Discord PATCH payloads use null to clear a channel relation
      // (for example `parent_id`); null is not an additional target.
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) {
        throw new Error(`runtime access target ${field} is invalid`);
      }
      const fields = channelFields.get(value) ?? [];
      fields.push(field);
      channelFields.set(value, fields);
    }
    for (const field of CHANNEL_ARRAY_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new Error(`runtime access target ${field} is invalid`);
      for (const item of value) {
        if (typeof item !== 'string' || !SNOWFLAKE_RE.test(item)) {
          throw new Error(`runtime access target ${field} is invalid`);
        }
        const fields = channelFields.get(item) ?? [];
        fields.push(field);
        channelFields.set(item, fields);
      }
    }
    if (channelFields.size === 0) {
      const webhookChannel = await resolveWebhookChannel(args, signal);
      if (webhookChannel !== undefined) channelFields.set(webhookChannel, ['webhook']);
    }
    if (channelFields.size === 0) {
      throw new Error('runtime access target channel is unresolved');
    }
    return Promise.all(
      [...channelFields].map(async ([channelId, fields]) => ({
        fields,
        ...(await resolveChannelById(channelId, signal)),
      })),
    );
  };

  const hierarchy = async (
    request: RuntimeAccessRequest,
    guild: GuildSnapshot,
    signal?: AbortSignal,
  ): Promise<HierarchyEvidenceStatus> => {
    if (request.requirement.hierarchy !== 'required') return 'satisfied';
    // Discord creates a new role below the bot's current top role; there is no
    // caller-selected target whose hierarchy must be compared.
    if (request.toolName === 'roles_create') return 'satisfied';
    const args = asRecord(request.args);
    const roles = [...guild.roles];
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const everyone = roleById.get(guild.id);
    if (everyone === undefined) return 'unknown';
    const botRoles = guild.member.roles
      .map((roleId) => roleById.get(roleId))
      .filter((role): role is BotRoleSnapshot => role !== undefined);
    if (botRoles.length !== guild.member.roles.length) return 'unknown';
    const botTop = botRoles.reduce(
      (top, role) => (role.position > top.position ? role : top),
      everyone,
    );
    const targetUserId =
      (typeof args.user_id === 'string' && SNOWFLAKE_RE.test(args.user_id)
        ? args.user_id
        : undefined) ??
      (typeof args.target_user_id === 'string' && SNOWFLAKE_RE.test(args.target_user_id)
        ? args.target_user_id
        : undefined);
    const targetRoleIds: string[] = [];
    if (typeof args.role_id === 'string' && SNOWFLAKE_RE.test(args.role_id))
      targetRoleIds.push(args.role_id);
    if (Array.isArray(args.positions)) {
      for (const position of args.positions) {
        if (
          isRecord(position) &&
          typeof position.id === 'string' &&
          SNOWFLAKE_RE.test(position.id)
        ) {
          targetRoleIds.push(position.id);
        }
      }
    }
    if (targetRoleIds.length > 0) {
      return targetRoleIds.every((roleId) => {
        const targetRole = roleById.get(roleId);
        return (
          targetRole !== undefined && !targetRole.managed && botTop.position > targetRole.position
        );
      })
        ? 'satisfied'
        : targetRoleIds.every((roleId) => roleById.has(roleId))
          ? 'not_satisfied'
          : 'unknown';
    }
    if (targetUserId === undefined) return 'unknown';
    if (targetUserId === guild.member.id) return 'satisfied';
    if (targetUserId === guild.ownerId) return 'not_satisfied';
    const target = parseMember(
      await get<unknown>(Routes.guildMember(guild.id, targetUserId), signal),
      targetUserId,
    );
    const targetRoles = target.roles
      .map((roleId) => roleById.get(roleId))
      .filter((role): role is BotRoleSnapshot => role !== undefined);
    if (targetRoles.length !== target.roles.length) return 'unknown';
    const targetTop = targetRoles.reduce(
      (top, role) => (role.position > top.position ? role : top),
      everyone,
    );
    return botTop.position > targetTop.position ? 'satisfied' : 'not_satisfied';
  };

  const resolve = async (request: RuntimeAccessRequest): Promise<RuntimeAccessEvidence> => {
    const identity = await readIdentity(request.signal);
    const context: ResolverContext = {
      identity,
      runtimeIntents,
    };
    const expectedBotId = request.expectedBotId ?? options.expectedBotId;
    if (expectedBotId !== undefined && identity.id !== expectedBotId) {
      return unknownEvidence(context, identity.id);
    }
    if (request.requirement.scope === 'user') {
      const recipientId = stringArg(request.args, 'recipient_id');
      // Identity is verified above, but recipient consent is deliberately not
      // inferred from a user lookup. The resolver only proves that the target
      // is a well-formed, caller-supplied Discord user snowflake.
      if (recipientId === undefined) return unknownEvidence(context);
      return evidence(context, 'complete', `user/${recipientId}`, request.requirement);
    }
    if (request.requirement.scope === 'bot_application') {
      const args = asRecord(request.args);
      if (request.toolName === 'users_get_current' || request.toolName === 'users_modify_current') {
        return evidence(context, 'complete', identity.id, request.requirement);
      }
      const explicit = args.application_id;
      if (explicit !== undefined && (typeof explicit !== 'string' || explicit !== identity.id)) {
        return unknownEvidence(context, typeof explicit === 'string' ? explicit : undefined);
      }
      let application: string;
      if (typeof args.sku_id === 'string' && SNOWFLAKE_RE.test(args.sku_id)) {
        const sku = (await get<RawSku>(`/skus/${args.sku_id}`, request.signal)) as RawSku;
        const applicationId = id(sku.application_id, 'SKU application ID');
        if (applicationId !== identity.id) return unknownEvidence(context, applicationId);
        application = applicationId;
      } else {
        application = parseApplication(
          await get<RawApplication>(Routes.currentApplication(), request.signal),
          identity.id,
        );
      }
      return evidence(context, 'complete', application, request.requirement);
    }
    if (request.requirement.scope === 'global') {
      return evidence(context, 'complete', 'global', request.requirement);
    }

    let guildId = stringArg(request.args, 'guild_id');
    let target = guildId;
    let resolvedChannels: ReadonlyArray<ResolvedChannelTarget> | undefined;
    let permissionChannels: ReadonlyArray<ResolvedChannelTarget> | undefined;
    if (request.requirement.scope === 'channel') {
      const channels = await resolveChannels(request.args, request.signal);
      resolvedChannels = channels;
      const resolvedGuildIds = new Set(channels.map((channel) => channel.target.guildId));
      if (
        (resolvedGuildIds.size > 1 && request.requirement.allowCrossGuild !== true) ||
        (guildId !== undefined && channels.some((channel) => channel.target.guildId !== guildId))
      ) {
        return unknownEvidence(context, 'channel-target-guild-mismatch');
      }
      guildId = channels[0]!.target.guildId;
      target = channels
        .map((channel) => `${channel.target.guildId}/${channel.target.id}`)
        .join(',');
      const targetFields = request.requirement.permissionTargetFields;
      const selected =
        targetFields === undefined
          ? channels
          : channels.filter((channel) =>
              channel.fields.some((field) => targetFields.includes(field)),
            );
      if (selected.length === 0) return unknownEvidence(context, 'permission-target-unresolved');
      permissionChannels = selected;
    } else {
      // Some guild contracts are expressed through a channel, thread, or
      // webhook channel field. Resolve that immutable relationship before
      // evaluating guild membership instead of guessing from an opaque ID.
      // When both are supplied, verify they describe the same guild; otherwise
      // a valid guild target could be paired with a foreign channel target.
      const input = asRecord(request.args);
      const hasChannelHint =
        CHANNEL_FIELDS.some((field) => input[field] !== undefined) ||
        CHANNEL_ARRAY_FIELDS.some((field) => input[field] !== undefined);
      const hasWebhookHint = (() => {
        const input = asRecord(request.args);
        return typeof input.webhook_id === 'string' && SNOWFLAKE_RE.test(input.webhook_id);
      })();
      if (guildId !== undefined && !hasChannelHint && !hasWebhookHint) {
        // Keep the explicit guild target.
      } else
        try {
          const channels = await resolveChannels(request.args, request.signal);
          resolvedChannels = channels;
          const resolvedGuildIds = new Set(channels.map((channel) => channel.target.guildId));
          if (
            (resolvedGuildIds.size > 1 && request.requirement.allowCrossGuild !== true) ||
            (guildId !== undefined &&
              channels.some((channel) => channel.target.guildId !== guildId))
          ) {
            return unknownEvidence(context, 'multiple-guild-channel-targets');
          }
          const resolvedGuildId = channels[0]!.target.guildId;
          guildId = resolvedGuildId;
          target = [...resolvedGuildIds].join(',');
          const targetFields = request.requirement.permissionTargetFields;
          if (targetFields !== undefined) {
            const selected = channels.filter((channel) =>
              channel.fields.some((field) => targetFields.includes(field)),
            );
            if (selected.length === 0)
              return unknownEvidence(context, 'permission-target-unresolved');
            permissionChannels = selected;
          }
        } catch (error) {
          if (request.signal?.aborted) throw error;
          if (request.toolName.startsWith('invites_') && !hasChannelHint && !hasWebhookHint) {
            guildId = await resolveInviteGuild(request.args, request.signal);
            target = guildId;
          } else return unknownEvidence(context);
        }
    }
    if (guildId === undefined) {
      // A guild contract without an explicit guild target cannot be safely
      // inferred from arbitrary IDs. Keep this unknown rather than guessing.
      return unknownEvidence(context);
    }
    if (guildId === undefined || target === undefined) return unknownEvidence(context);
    const guildIds = [
      ...new Set(resolvedChannels?.map((channel) => channel.target.guildId) ?? [guildId]),
    ];
    const guildEntries = await Promise.all(
      guildIds.map(async (id) => [id, await readGuild(id, identity.id, request.signal)] as const),
    );
    const guilds = new Map(guildEntries);
    const primaryGuild = guilds.get(guildId);
    if (primaryGuild === undefined) return unknownEvidence(context);
    const permissionEvaluations =
      permissionChannels === undefined || permissionChannels.length === 0
        ? [
            evaluateBotPermissions({
              guildId,
              ...(primaryGuild.ownerId === undefined ? {} : { guildOwnerId: primaryGuild.ownerId }),
              roles: primaryGuild.roles,
              member: primaryGuild.member,
            }),
          ]
        : permissionChannels.map((channel) => {
            const channelGuild = guilds.get(channel.target.guildId);
            if (channelGuild === undefined) throw new Error('channel guild evidence is missing');
            return evaluateBotPermissions({
              guildId: channel.target.guildId,
              ...(channelGuild.ownerId === undefined ? {} : { guildOwnerId: channelGuild.ownerId }),
              roles: channelGuild.roles,
              member: channelGuild.member,
              channel: channel.permissionChannel,
            });
          });
    const firstEvaluation = permissionEvaluations[0]!;
    const evaluation = {
      ...firstEvaluation,
      missingRoleIds: [...firstEvaluation.missingRoleIds],
    };
    for (const current of permissionEvaluations.slice(1)) {
      evaluation.effectivePermissions &= current.effectivePermissions;
      evaluation.unknownPermissionBits |= current.unknownPermissionBits;
      evaluation.missingRoleIds = [
        ...new Set([...evaluation.missingRoleIds, ...current.missingRoleIds]),
      ];
      evaluation.confidence =
        evaluation.confidence === 'complete' && current.confidence === 'complete'
          ? 'complete'
          : 'partial';
    }
    const status = evaluation.confidence === 'complete' ? 'complete' : 'partial';
    const hierarchyStates = await Promise.all(
      [...guilds.values()].map((guild) => hierarchy(request, guild, request.signal)),
    );
    const hierarchyState = hierarchyStates.some((state) => state === 'unknown')
      ? 'unknown'
      : hierarchyStates.some((state) => state === 'not_satisfied')
        ? 'not_satisfied'
        : 'satisfied';
    return {
      status,
      identityVerified: true,
      botId: identity.id,
      target,
      effectivePermissions: evaluation.effectivePermissions,
      intents: intentEvidence(request.requirement, context.runtimeIntents),
      hierarchy: hierarchyState,
    };
  };

  const resolver = (async (request: RuntimeAccessRequest): Promise<RuntimeAccessEvidence> => {
    try {
      return await resolve(request);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      // The middleware deliberately turns provider failures into a generic
      // unknown-access result. Do not expose Discord URLs, IDs, or raw errors.
      const expectedBotId = request.expectedBotId ?? options.expectedBotId;
      return {
        status: 'unknown',
        identityVerified: false,
        ...(expectedBotId === undefined ? {} : { botId: expectedBotId }),
      };
    }
  }) as RuntimeAccessResolverHandle;
  resolver.invalidate = invalidate;
  return resolver;
}

function evidence(
  context: ResolverContext,
  status: 'complete',
  target: string,
  requirement: DiscordAccessRequirement,
): RuntimeAccessEvidence {
  return {
    status,
    identityVerified: true,
    botId: context.identity.id,
    target,
    effectivePermissions: 0n,
    intents: intentEvidence(requirement, context.runtimeIntents),
    hierarchy: requirement.hierarchy === 'required' ? 'unknown' : 'satisfied',
  };
}

function unknownEvidence(context: ResolverContext, target?: string): RuntimeAccessEvidence {
  return {
    status: 'unknown',
    identityVerified: true,
    botId: context.identity.id,
    ...(target === undefined ? {} : { target }),
  };
}

function intentEvidence(
  requirement: DiscordAccessRequirement,
  configured: Readonly<Partial<Record<GatewayIntentName, RuntimeIntentState>>>,
): Partial<Record<GatewayIntentName, RuntimeIntentState>> {
  return Object.fromEntries(
    requirement.intents.map((intent) => [intent, configured[intent] ?? 'unknown']),
  ) as Partial<Record<GatewayIntentName, RuntimeIntentState>>;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
