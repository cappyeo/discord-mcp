import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord-api-types/v10';
import {
  desiredAutoModBody,
  desiredCategoryBody,
  desiredChannelBody,
  desiredGuildBody,
  desiredOnboardingBody,
  desiredOverwrites,
  desiredPublicationBody,
  desiredRoleBody,
  desiredWelcomeBody,
  permissionNames,
  requiredBotPermissionBits,
} from './blueprint.desired.js';
import {
  type BlueprintBindings,
  type BlueprintBlocker,
  type BlueprintExecutionPhase,
  type BlueprintOperation,
  type BlueprintPlanSummary,
  emptyBlueprintBindings,
} from './blueprint.execution.schema.js';
import type { GuildBlueprint } from './blueprint.schema.js';
import {
  type BlueprintTargetSnapshot,
  channelType,
  type TargetAutoModRule,
  type TargetChannel,
  type TargetMessage,
  type TargetRole,
} from './blueprint.target.js';
import { canonicalJson } from './blueprint.validation.js';

export interface BlueprintReconcileResult {
  readonly snapshot_id: string;
  readonly bindings: BlueprintBindings;
  readonly operations: BlueprintOperation[];
  readonly blockers: BlueprintBlocker[];
  readonly warnings: string[];
  readonly bot_permissions: {
    readonly administrator: boolean;
    readonly missing: string[];
    readonly top_role_id: string | null;
    readonly top_role_position: number;
  };
}

const PHASES: readonly BlueprintExecutionPhase[] = [
  'roles',
  'categories',
  'channels',
  'ordering',
  'guild',
  'welcome',
  'onboarding',
  'automod',
  'publications',
];

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function cloneBindings(seed: BlueprintBindings | undefined): BlueprintBindings {
  const source = seed ?? emptyBlueprintBindings();
  return {
    roles: { ...source.roles },
    categories: { ...source.categories },
    channels: { ...source.channels },
    automod_rules: { ...source.automod_rules },
    publications: { ...source.publications },
  };
}

function normalizeOverwrites(
  overwrites: readonly { id: string; type: number; allow?: string; deny?: string }[],
) {
  return overwrites
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow ?? '0',
      deny: overwrite.deny ?? '0',
    }))
    .sort((left, right) =>
      left.type === right.type ? left.id.localeCompare(right.id) : left.type - right.type,
    );
}

function roleMatches(role: TargetRole, desired: GuildBlueprint['roles'][number]): boolean {
  const body = desiredRoleBody(desired);
  return (
    role.name === body.name &&
    role.permissions === body.permissions &&
    role.color === body.color &&
    role.hoist === body.hoist &&
    role.mentionable === body.mentionable
  );
}

function categoryMatches(
  category: TargetChannel,
  desired: GuildBlueprint['categories'][number],
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): boolean {
  const body = desiredCategoryBody(desired, guildId, botId, bindings);
  if (body === null) return false;
  return (
    category.type === ChannelType.GuildCategory &&
    category.name === desired.name &&
    category.parent_id === null &&
    canonicalJson(normalizeOverwrites(category.permission_overwrites)) ===
      canonicalJson(
        normalizeOverwrites(
          body.permission_overwrites as Array<{
            id: string;
            type: number;
            allow: string;
            deny: string;
          }>,
        ),
      )
  );
}

function forumTags(channel: TargetChannel) {
  return channel.available_tags.map((tag) => ({
    name: tag.name,
    moderated: tag.moderated,
    emoji_id: tag.emoji_id,
    emoji_name: tag.emoji_name,
  }));
}

function channelMatches(
  channel: TargetChannel,
  desired: GuildBlueprint['channels'][number],
  blueprint: GuildBlueprint,
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): boolean {
  const body = desiredChannelBody(desired, guildId, botId, bindings);
  if (body === null) return false;
  let overwritesMatch = true;
  if (desired.overwrites.length > 0) {
    overwritesMatch =
      canonicalJson(normalizeOverwrites(channel.permission_overwrites)) ===
      canonicalJson(
        normalizeOverwrites(
          body.permission_overwrites as Array<{
            id: string;
            type: number;
            allow: string;
            deny: string;
          }>,
        ),
      );
  } else {
    const parent = blueprint.categories.find((category) => category.key === desired.parent_key);
    const inherited =
      parent === undefined ? null : desiredOverwrites(parent.overwrites, guildId, botId, bindings);
    const current = canonicalJson(normalizeOverwrites(channel.permission_overwrites));
    overwritesMatch =
      current === canonicalJson([]) ||
      (inherited !== null && current === canonicalJson(normalizeOverwrites(inherited)));
  }
  return (
    channel.name === desired.name &&
    channel.type === channelType(desired.type) &&
    channel.parent_id === body.parent_id &&
    channel.topic === (body.topic ?? null) &&
    channel.nsfw === false &&
    channel.rate_limit_per_user === desired.slowmode_seconds &&
    overwritesMatch &&
    (desired.type !== 'forum' ||
      canonicalJson(forumTags(channel)) === canonicalJson(body.available_tags ?? []))
  );
}

function operation(
  phase: BlueprintExecutionPhase,
  action: BlueprintOperation['action'],
  resource: BlueprintOperation['resource'],
  key: string,
  summary: string,
  risk: BlueprintOperation['risk'] = 'low',
): BlueprintOperation {
  return {
    operation_id: `${resource}:${key}:ensure`,
    phase,
    action,
    resource,
    key,
    summary,
    risk,
  };
}

function blocker(
  code: string,
  message: string,
  resource: string | null,
  recoveryHint: string,
): BlueprintBlocker {
  return { code, message, resource, recovery_hint: recoveryHint };
}

function roleOrder(left: TargetRole, right: TargetRole): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.id === right.id) return 0;
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

function channelOrder(left: TargetChannel, right: TargetChannel): number {
  if (left.position !== right.position) return left.position - right.position;
  if (left.id === right.id) return 0;
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

function botPermissionState(snapshot: BlueprintTargetSnapshot, blueprint: GuildBlueprint) {
  const everyone = snapshot.roles.find((role) => role.id === snapshot.guild.id);
  const assigned = snapshot.roles.filter((role) => snapshot.bot.roles.includes(role.id));
  const top = [...assigned].sort(roleOrder).at(-1) ?? null;
  let effective = everyone === undefined ? 0n : BigInt(everyone.permissions);
  for (const role of assigned) effective |= BigInt(role.permissions);
  const administrator =
    snapshot.guild.owner_id === snapshot.bot.user.id ||
    (effective & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
  const required = requiredBotPermissionBits(blueprint);
  const missingBits = administrator ? 0n : required & ~effective;
  return {
    administrator,
    missing: permissionNames(missingBits),
    top_role_id: top?.id ?? null,
    top_role_position: top?.position ?? 0,
  };
}

function normalizeGuild(snapshot: BlueprintTargetSnapshot) {
  const guild = snapshot.guild;
  return {
    name: guild.name,
    description: guild.description,
    preferred_locale: guild.preferred_locale,
    verification_level: guild.verification_level,
    default_message_notifications: guild.default_message_notifications,
    explicit_content_filter: guild.explicit_content_filter,
    rules_channel_id: guild.rules_channel_id,
    public_updates_channel_id: guild.public_updates_channel_id,
    safety_alerts_channel_id: guild.safety_alerts_channel_id,
    features: [...guild.features].sort(),
  };
}

function guildMatches(
  snapshot: BlueprintTargetSnapshot,
  desired: Record<string, unknown>,
): boolean {
  return canonicalJson(normalizeGuild(snapshot)) === canonicalJson(desired);
}

function normalizeWelcome(screen: BlueprintTargetSnapshot['welcome_screen']) {
  if (screen === null) return null;
  return {
    description: screen.description,
    welcome_channels: screen.welcome_channels.map((channel) => ({
      channel_id: channel.channel_id,
      description: channel.description,
      emoji_id: channel.emoji_id,
      emoji_name: channel.emoji_name,
    })),
  };
}

function welcomeMatches(
  snapshot: BlueprintTargetSnapshot,
  desired: Record<string, unknown>,
): boolean {
  if (!snapshot.guild.features.includes('WELCOME_SCREEN_ENABLED')) return false;
  const comparable = {
    description: desired.description,
    welcome_channels: desired.welcome_channels,
  };
  return canonicalJson(normalizeWelcome(snapshot.welcome_screen)) === canonicalJson(comparable);
}

function normalizeOnboardingPrompt(prompt: Record<string, unknown>) {
  const options = Array.isArray(prompt.options) ? prompt.options : [];
  return {
    type: prompt.type,
    title: prompt.title,
    single_select: prompt.single_select,
    required: prompt.required,
    in_onboarding: prompt.in_onboarding,
    options: options.map((raw) => {
      const option = raw as Record<string, unknown>;
      return {
        title: option.title,
        description: option.description ?? '',
        role_ids: Array.isArray(option.role_ids) ? [...option.role_ids].sort() : [],
        channel_ids: Array.isArray(option.channel_ids) ? [...option.channel_ids].sort() : [],
        emoji_id: option.emoji_id ?? null,
        emoji_name: option.emoji_name ?? null,
        emoji_animated: option.emoji_animated ?? false,
      };
    }),
  };
}

function onboardingMatches(
  snapshot: BlueprintTargetSnapshot,
  desired: Record<string, unknown>,
): boolean {
  const current = snapshot.onboarding;
  if (current === null) return false;
  const desiredPrompts = desired.prompts as Array<Record<string, unknown>>;
  return (
    current.enabled === desired.enabled &&
    current.mode === desired.mode &&
    canonicalJson([...current.default_channel_ids].sort()) ===
      canonicalJson([...(desired.default_channel_ids as string[])].sort()) &&
    canonicalJson(current.prompts.map(normalizeOnboardingPrompt)) ===
      canonicalJson(desiredPrompts.map(normalizeOnboardingPrompt))
  );
}

function normalizeAutoMod(value: TargetAutoModRule | Record<string, unknown>) {
  const triggerMetadata = (value.trigger_metadata as Record<string, unknown> | undefined) ?? {};
  const actions = Array.isArray(value.actions) ? value.actions : [];
  return {
    name: value.name,
    event_type: value.event_type,
    trigger_type: value.trigger_type,
    trigger_metadata: triggerMetadata,
    actions,
    enabled: value.enabled,
    exempt_roles: [...((value.exempt_roles as string[] | undefined) ?? [])].sort(),
    exempt_channels: [...((value.exempt_channels as string[] | undefined) ?? [])].sort(),
  };
}

function autoModMatches(rule: TargetAutoModRule, desired: Record<string, unknown>): boolean {
  return canonicalJson(normalizeAutoMod(rule)) === canonicalJson(normalizeAutoMod(desired));
}

function containsMarker(value: unknown, marker: string): boolean {
  if (typeof value === 'string') return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => containsMarker(item, marker));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => containsMarker(item, marker));
  }
  return false;
}

function normalizePublicationComponents(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePublicationComponents);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key !== 'id' || typeof item !== 'number')
      .map(([key, item]) => [key, normalizePublicationComponents(item)]),
  );
}

function publicationMatches(
  message: TargetMessage,
  desired: NonNullable<ReturnType<typeof desiredPublicationBody>>,
  botId: string,
): boolean {
  const desiredFlags = desired.body.flags as number;
  const desiredNonce = desired.body.nonce as string;
  return (
    message.channel_id === desired.channel_id &&
    message.author?.id === botId &&
    typeof message.flags === 'number' &&
    (message.flags & desiredFlags) === desiredFlags &&
    canonicalJson(normalizePublicationComponents(message.components ?? [])) ===
      canonicalJson(normalizePublicationComponents(desired.body.components ?? [])) &&
    (message.nonce === undefined || String(message.nonce) === desiredNonce) &&
    message.mention_everyone !== true &&
    (message.mentions?.length ?? 0) === 0 &&
    (message.mention_roles?.length ?? 0) === 0
  );
}

function markerMessages(
  messages: readonly TargetMessage[],
  marker: string,
  botId: string,
): TargetMessage[] {
  return messages
    .filter((message) => message.author?.id === botId && containsMarker(message.components, marker))
    .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? 1 : -1));
}

function targetSnapshotId(
  snapshot: BlueprintTargetSnapshot,
  publicationBindings: Readonly<Record<string, string>>,
): string {
  return digest({
    guild: normalizeGuild(snapshot),
    bot: { id: snapshot.bot.user.id, roles: [...snapshot.bot.roles].sort() },
    roles: [...snapshot.roles]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((role) => ({ ...role })),
    channels: [...snapshot.channels]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        position: channel.position,
        parent_id: channel.parent_id,
        topic: channel.topic,
        nsfw: channel.nsfw,
        rate_limit_per_user: channel.rate_limit_per_user,
        permission_overwrites: normalizeOverwrites(channel.permission_overwrites),
        available_tags: forumTags(channel),
      })),
    automod_rules: [...snapshot.automod_rules]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(normalizeAutoMod),
    onboarding:
      snapshot.onboarding === null
        ? null
        : {
            enabled: snapshot.onboarding.enabled,
            mode: snapshot.onboarding.mode,
            default_channel_ids: [...snapshot.onboarding.default_channel_ids].sort(),
            prompts: snapshot.onboarding.prompts.map(normalizeOnboardingPrompt),
          },
    welcome_screen: normalizeWelcome(snapshot.welcome_screen),
    publications: publicationBindings,
  });
}

function ensureBoundRoleManageable(
  role: TargetRole,
  botTopPosition: number,
): BlueprintBlocker | null {
  if (role.managed) {
    return blocker(
      'UNMANAGEABLE_RESOURCE',
      'A generated role key is bound to a Discord-managed role.',
      `role:${role.id}`,
      'Remove the stale checkpoint binding or choose a non-managed role name.',
    );
  }
  if (role.position >= botTopPosition) {
    return blocker(
      'BOT_ROLE_HIERARCHY',
      'A generated role is at or above the bot highest role.',
      `role:${role.id}`,
      'Move the bot role above every generated role; discord-mcp never elevates itself.',
    );
  }
  return null;
}

export function reconcileGuildBlueprint(
  blueprintId: string,
  blueprint: GuildBlueprint,
  snapshot: BlueprintTargetSnapshot,
  seedBindings?: BlueprintBindings,
): BlueprintReconcileResult {
  const bindings = cloneBindings(seedBindings);
  const blockers: BlueprintBlocker[] = [];
  const warnings: string[] = [];
  const roleOperations: BlueprintOperation[] = [];
  const categoryOperations: BlueprintOperation[] = [];
  const channelOperations: BlueprintOperation[] = [];
  const stageOperations: BlueprintOperation[] = [];
  const automodOperations: BlueprintOperation[] = [];
  const publicationOperations: BlueprintOperation[] = [];
  const permissionState = botPermissionState(snapshot, blueprint);

  if (permissionState.top_role_id === null || permissionState.top_role_position <= 0) {
    blockers.push(
      blocker(
        'BOT_ROLE_HIERARCHY',
        'The bot has no manageable role above @everyone.',
        `bot:${snapshot.bot.user.id}`,
        'Install the bot with a dedicated role above the roles it will create.',
      ),
    );
  }
  if (permissionState.missing.length > 0) {
    blockers.push(
      blocker(
        'MISSING_PERMISSIONS',
        `The bot is missing required permissions: ${permissionState.missing.join(', ')}.`,
        `bot:${snapshot.bot.user.id}`,
        'Grant only the listed permissions to the bot role, then plan again.',
      ),
    );
  }
  if (!snapshot.guild.features.includes('COMMUNITY') && !permissionState.administrator) {
    blockers.push(
      blocker(
        'COMMUNITY_REQUIRES_ADMINISTRATOR',
        'Discord requires Administrator to enable the Community feature.',
        `guild:${snapshot.guild.id}`,
        'Temporarily authorize a caller-owned bot with Administrator, or enable Community manually before applying.',
      ),
    );
  }

  const desiredRoleKeys = new Set(blueprint.roles.map((role) => role.key));
  for (const key of Object.keys(bindings.roles)) {
    if (!desiredRoleKeys.has(key)) delete bindings.roles[key];
  }
  for (const desired of blueprint.roles) {
    let current =
      bindings.roles[desired.key] === undefined
        ? undefined
        : snapshot.roles.find((role) => role.id === bindings.roles[desired.key]);
    if (current === undefined) delete bindings.roles[desired.key];
    if (current !== undefined) {
      const hierarchy = ensureBoundRoleManageable(current, permissionState.top_role_position);
      if (hierarchy !== null) blockers.push(hierarchy);
      if (!roleMatches(current, desired)) {
        roleOperations.push(
          operation(
            'roles',
            'update',
            'role',
            desired.key,
            `Update role ${desired.name}.`,
            'medium',
          ),
        );
      }
      continue;
    }
    const matches = snapshot.roles.filter((role) => role.name === desired.name);
    if (matches.length > 1) {
      blockers.push(
        blocker(
          'AMBIGUOUS_RESOURCE',
          `Multiple roles are named ${desired.name}; discord-mcp will not guess.`,
          `role-key:${desired.key}`,
          'Rename duplicates or resume with a valid checkpoint binding.',
        ),
      );
      continue;
    }
    current = matches[0];
    if (current !== undefined) {
      const hierarchy = ensureBoundRoleManageable(current, permissionState.top_role_position);
      if (hierarchy !== null) blockers.push(hierarchy);
      if (!roleMatches(current, desired)) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            `An unbound role named ${desired.name} differs from the safe blueprint.`,
            `role:${current.id}`,
            'Rename the existing role or explicitly resume the original managed plan.',
          ),
        );
      } else {
        bindings.roles[desired.key] = current.id;
      }
      continue;
    }
    roleOperations.push(
      operation('roles', 'create', 'role', desired.key, `Create role ${desired.name}.`),
    );
  }

  const desiredCategoryKeys = new Set(blueprint.categories.map((category) => category.key));
  for (const key of Object.keys(bindings.categories)) {
    if (!desiredCategoryKeys.has(key)) delete bindings.categories[key];
  }
  for (const desired of blueprint.categories) {
    let current =
      bindings.categories[desired.key] === undefined
        ? undefined
        : snapshot.channels.find((channel) => channel.id === bindings.categories[desired.key]);
    if (current === undefined) delete bindings.categories[desired.key];
    if (current !== undefined) {
      if (current.type !== ChannelType.GuildCategory) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            'A category binding now points to a different channel type.',
            `channel:${current.id}`,
            'Create a fresh plan after resolving the external type change.',
          ),
        );
      } else if (
        !categoryMatches(current, desired, snapshot.guild.id, snapshot.bot.user.id, bindings)
      ) {
        categoryOperations.push(
          operation(
            'categories',
            'update',
            'category',
            desired.key,
            `Reconcile category ${desired.name}.`,
            'medium',
          ),
        );
      }
      continue;
    }
    const matches = snapshot.channels.filter(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === desired.name,
    );
    if (matches.length > 1) {
      blockers.push(
        blocker(
          'AMBIGUOUS_RESOURCE',
          `Multiple categories are named ${desired.name}; discord-mcp will not guess.`,
          `category-key:${desired.key}`,
          'Rename duplicates or resume with a valid checkpoint binding.',
        ),
      );
      continue;
    }
    current = matches[0];
    if (current !== undefined) {
      if (!categoryMatches(current, desired, snapshot.guild.id, snapshot.bot.user.id, bindings)) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            `An unbound category named ${desired.name} differs from the safe blueprint.`,
            `channel:${current.id}`,
            'Rename the existing category or explicitly resume the original managed plan.',
          ),
        );
      } else {
        bindings.categories[desired.key] = current.id;
      }
      continue;
    }
    categoryOperations.push(
      operation(
        'categories',
        'create',
        'category',
        desired.key,
        `Create category ${desired.name}.`,
      ),
    );
  }

  const desiredChannelKeys = new Set(blueprint.channels.map((channel) => channel.key));
  for (const key of Object.keys(bindings.channels)) {
    if (!desiredChannelKeys.has(key)) delete bindings.channels[key];
  }
  for (const desired of blueprint.channels) {
    let current =
      bindings.channels[desired.key] === undefined
        ? undefined
        : snapshot.channels.find((channel) => channel.id === bindings.channels[desired.key]);
    if (current === undefined) delete bindings.channels[desired.key];
    const targetOperations = desired.type === 'stage' ? stageOperations : channelOperations;
    if (current !== undefined) {
      if (current.type !== channelType(desired.type)) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            'A channel binding now points to an incompatible channel type.',
            `channel:${current.id}`,
            'Create a fresh plan after resolving the external type change.',
          ),
        );
      } else if (
        !channelMatches(
          current,
          desired,
          blueprint,
          snapshot.guild.id,
          snapshot.bot.user.id,
          bindings,
        )
      ) {
        targetOperations.push(
          operation(
            'channels',
            'update',
            'channel',
            desired.key,
            `Reconcile channel ${desired.name}.`,
            'medium',
          ),
        );
      }
      continue;
    }
    const matches = snapshot.channels.filter(
      (channel) => channel.type === channelType(desired.type) && channel.name === desired.name,
    );
    if (matches.length > 1) {
      blockers.push(
        blocker(
          'AMBIGUOUS_RESOURCE',
          `Multiple channels are named ${desired.name} with the same type.`,
          `channel-key:${desired.key}`,
          'Rename duplicates or resume with a valid checkpoint binding.',
        ),
      );
      continue;
    }
    current = matches[0];
    if (current !== undefined) {
      if (
        !channelMatches(
          current,
          desired,
          blueprint,
          snapshot.guild.id,
          snapshot.bot.user.id,
          bindings,
        )
      ) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            `An unbound channel named ${desired.name} differs from the safe blueprint.`,
            `channel:${current.id}`,
            'Rename the existing channel or explicitly resume the original managed plan.',
          ),
        );
      } else {
        bindings.channels[desired.key] = current.id;
      }
      continue;
    }
    targetOperations.push(
      operation(
        'channels',
        'create',
        'channel',
        desired.key,
        `Create ${desired.type} channel ${desired.name}.`,
      ),
    );
  }

  const anyStructuralCreate = [
    ...roleOperations,
    ...categoryOperations,
    ...channelOperations,
    ...stageOperations,
  ].some((item) => item.action === 'create');
  let roleOrderingNeeded = anyStructuralCreate;
  if (
    !roleOrderingNeeded &&
    blueprint.roles.every((role) => bindings.roles[role.key] !== undefined)
  ) {
    const keyById = new Map(Object.entries(bindings.roles).map(([key, id]) => [id, key]));
    const currentOrder = snapshot.roles
      .filter((role) => keyById.has(role.id))
      .sort(roleOrder)
      .map((role) => keyById.get(role.id)!);
    roleOrderingNeeded = canonicalJson(currentOrder) !== canonicalJson(blueprint.role_order);
  }
  const desiredCategoryOrder = [...blueprint.categories]
    .sort((left, right) => left.position - right.position)
    .map((category) => category.key);
  let channelOrderingNeeded = anyStructuralCreate;
  if (
    !channelOrderingNeeded &&
    blueprint.categories.every((category) => bindings.categories[category.key] !== undefined) &&
    blueprint.channels.every((channel) => bindings.channels[channel.key] !== undefined)
  ) {
    const categoryKeyById = new Map(
      Object.entries(bindings.categories).map(([key, id]) => [id, key]),
    );
    const currentCategoryOrder = snapshot.channels
      .filter((channel) => categoryKeyById.has(channel.id))
      .sort(channelOrder)
      .map((channel) => categoryKeyById.get(channel.id)!);
    channelOrderingNeeded =
      canonicalJson(currentCategoryOrder) !== canonicalJson(desiredCategoryOrder);
    if (!channelOrderingNeeded) {
      for (const category of blueprint.categories) {
        const parentId = bindings.categories[category.key]!;
        const keyById = new Map(
          blueprint.channels
            .filter((channel) => channel.parent_key === category.key)
            .map((channel) => [bindings.channels[channel.key]!, channel.key]),
        );
        const currentOrder = snapshot.channels
          .filter((channel) => channel.parent_id === parentId && keyById.has(channel.id))
          .sort(channelOrder)
          .map((channel) => keyById.get(channel.id)!);
        const desiredOrder = [...blueprint.channels]
          .filter((channel) => channel.parent_key === category.key)
          .sort((left, right) => left.position - right.position)
          .map((channel) => channel.key);
        if (canonicalJson(currentOrder) !== canonicalJson(desiredOrder)) {
          channelOrderingNeeded = true;
          break;
        }
      }
    }
  }

  const guildBody = desiredGuildBody(blueprint, snapshot.guild.features, bindings);
  const guildOperationNeeded = guildBody === null || !guildMatches(snapshot, guildBody);
  const welcomeBody = desiredWelcomeBody(blueprint, bindings);
  const welcomeOperationNeeded = welcomeBody === null || !welcomeMatches(snapshot, welcomeBody);
  const onboardingBody = desiredOnboardingBody(blueprint, bindings, snapshot.onboarding);
  const onboardingOperationNeeded =
    onboardingBody === null || !onboardingMatches(snapshot, onboardingBody);
  if (
    onboardingOperationNeeded &&
    snapshot.onboarding !== null &&
    (snapshot.onboarding.prompts.length > 0 || snapshot.onboarding.default_channel_ids.length > 0)
  ) {
    warnings.push(
      'Applying this approved plan replaces the guild onboarding prompt/default-channel configuration.',
    );
  }

  const desiredRuleKeys = new Set(blueprint.automod.rules.map((rule) => rule.key));
  for (const key of Object.keys(bindings.automod_rules)) {
    if (!desiredRuleKeys.has(key)) delete bindings.automod_rules[key];
  }
  for (const desired of blueprint.automod.rules) {
    const body = desiredAutoModBody(desired, bindings);
    let current =
      bindings.automod_rules[desired.key] === undefined
        ? undefined
        : snapshot.automod_rules.find((rule) => rule.id === bindings.automod_rules[desired.key]);
    if (current === undefined) delete bindings.automod_rules[desired.key];
    if (current !== undefined) {
      if (current.trigger_type !== desired.trigger_type) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            'A bound AutoMod rule changed its immutable trigger type.',
            `automod-rule:${current.id}`,
            'Create a fresh plan after resolving the external rule change.',
          ),
        );
      } else if (body === null || !autoModMatches(current, body)) {
        automodOperations.push(
          operation(
            'automod',
            'update',
            'automod_rule',
            desired.key,
            `Reconcile AutoMod rule ${desired.name}.`,
            'medium',
          ),
        );
      }
      continue;
    }
    const matches = snapshot.automod_rules.filter((rule) => rule.name === desired.name);
    if (matches.length > 1) {
      blockers.push(
        blocker(
          'AMBIGUOUS_RESOURCE',
          `Multiple AutoMod rules are named ${desired.name}.`,
          `automod-key:${desired.key}`,
          'Rename duplicates or resume with a valid checkpoint binding.',
        ),
      );
      continue;
    }
    current = matches[0];
    if (current !== undefined) {
      if (body === null || !autoModMatches(current, body)) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            `An unbound AutoMod rule named ${desired.name} differs from the safe blueprint.`,
            `automod-rule:${current.id}`,
            'Rename the existing rule or explicitly resume the original managed plan.',
          ),
        );
      } else {
        bindings.automod_rules[desired.key] = current.id;
      }
      continue;
    }
    automodOperations.push(
      operation(
        'automod',
        'create',
        'automod_rule',
        desired.key,
        `Create AutoMod rule ${desired.name}.`,
        'medium',
      ),
    );
  }

  const desiredPublicationKeys = new Set(
    blueprint.components_v2.publications.map((publication) => publication.key),
  );
  for (const key of Object.keys(bindings.publications)) {
    if (!desiredPublicationKeys.has(key)) delete bindings.publications[key];
  }
  for (const publication of blueprint.components_v2.publications) {
    const desired = desiredPublicationBody(
      publication,
      blueprintId,
      snapshot.guild.id,
      snapshot.bot.user.id,
      bindings,
    );
    if (desired === null) {
      publicationOperations.push(
        operation(
          'publications',
          'send',
          'publication',
          publication.key,
          `Publish Components V2 content ${publication.key}.`,
          'medium',
        ),
      );
      continue;
    }
    const messages = snapshot.recent_messages[desired.channel_id] ?? [];
    const boundMessageId = bindings.publications[publication.key];
    if (boundMessageId !== undefined) {
      const boundMessage = messages.find((message) => message.id === boundMessageId);
      if (boundMessage !== undefined) {
        if (!publicationMatches(boundMessage, desired, snapshot.bot.user.id)) {
          blockers.push(
            blocker(
              'RESOURCE_CONFLICT',
              `The checkpoint-bound publication ${publication.key} no longer matches the approved Components V2 payload.`,
              `message:${boundMessageId}`,
              'Restore the managed publication or create a fresh plan after reviewing the external edit.',
            ),
          );
          continue;
        }
      } else {
        delete bindings.publications[publication.key];
      }
    }
    const matches = markerMessages(messages, desired.marker, snapshot.bot.user.id);
    const exactMatches = matches.filter((message) =>
      publicationMatches(message, desired, snapshot.bot.user.id),
    );
    if (exactMatches.length > 0) {
      bindings.publications[publication.key] = exactMatches[0]!.id;
      if (exactMatches.length > 1) {
        warnings.push(
          `Publication ${publication.key} already has ${exactMatches.length} exact managed copies; no additional copy will be sent.`,
        );
      }
      if (matches.length > exactMatches.length) {
        blockers.push(
          blocker(
            'RESOURCE_CONFLICT',
            `A second managed-marker publication for ${publication.key} has externally changed content.`,
            `message:${matches.find((message) => !exactMatches.includes(message))!.id}`,
            'Review the edited managed copy before resuming; discord-mcp will not add another copy.',
          ),
        );
      }
    } else if (matches.length > 0) {
      blockers.push(
        blocker(
          'RESOURCE_CONFLICT',
          `A managed-marker publication for ${publication.key} differs from the approved Components V2 payload.`,
          `message:${matches[0]!.id}`,
          'Review the edited managed message and create a fresh plan; discord-mcp will not duplicate it.',
        ),
      );
    } else if (snapshot.publication_history_complete[desired.channel_id] !== true) {
      delete bindings.publications[publication.key];
      blockers.push(
        blocker(
          'PUBLICATION_HISTORY_INCOMPLETE',
          `Discord history for ${publication.key} exceeded the bounded scan without finding a managed marker.`,
          `channel:${desired.channel_id}`,
          'Use a dedicated publication channel with bounded history or verify/remove the older managed copy before creating a fresh plan.',
        ),
      );
    } else {
      delete bindings.publications[publication.key];
      publicationOperations.push(
        operation(
          'publications',
          'send',
          'publication',
          publication.key,
          `Publish Components V2 content ${publication.key}.`,
          'medium',
        ),
      );
    }
  }

  const orderingOperations: BlueprintOperation[] = [];
  if (roleOrderingNeeded) {
    orderingOperations.push(
      operation('ordering', 'reorder', 'role_order', 'generated_roles', 'Order generated roles.'),
    );
  }
  if (channelOrderingNeeded) {
    orderingOperations.push(
      operation(
        'ordering',
        'reorder',
        'channel_order',
        'managed_channels',
        'Order managed categories and channels.',
      ),
    );
  }

  const singletonOperations: BlueprintOperation[] = [];
  if (guildOperationNeeded) {
    singletonOperations.push(
      operation(
        'guild',
        'update',
        'guild',
        'settings',
        'Configure guild safety settings and Community channels.',
        snapshot.guild.features.includes('COMMUNITY') ? 'medium' : 'high',
      ),
    );
  }
  if (welcomeOperationNeeded) {
    singletonOperations.push(
      operation(
        'welcome',
        'update',
        'welcome_screen',
        'main',
        'Replace and enable the approved Welcome Screen.',
        'high',
      ),
    );
  }
  if (onboardingOperationNeeded) {
    singletonOperations.push(
      operation(
        'onboarding',
        'update',
        'onboarding',
        'main',
        'Replace and enable the approved onboarding flow.',
        'high',
      ),
    );
  }

  const guildOperations = singletonOperations.filter((item) => item.phase === 'guild');
  const postStructureSingletons = singletonOperations.filter((item) => item.phase !== 'guild');
  const operations = [
    ...roleOperations,
    ...categoryOperations,
    ...channelOperations,
    ...guildOperations,
    ...stageOperations,
    ...orderingOperations,
    ...postStructureSingletons,
    ...automodOperations,
    ...publicationOperations,
  ];

  return {
    snapshot_id: targetSnapshotId(snapshot, bindings.publications),
    bindings,
    operations,
    blockers,
    warnings,
    bot_permissions: permissionState,
  };
}

export function summarizeBlueprintOperations(
  operations: readonly BlueprintOperation[],
): BlueprintPlanSummary {
  const byPhase = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
    BlueprintExecutionPhase,
    number
  >;
  for (const item of operations) byPhase[item.phase] += 1;
  return {
    total_operations: operations.length,
    create_operations: operations.filter((item) => item.action === 'create').length,
    update_operations: operations.filter((item) => item.action === 'update').length,
    reorder_operations: operations.filter((item) => item.action === 'reorder').length,
    send_operations: operations.filter((item) => item.action === 'send').length,
    high_risk_operations: operations.filter((item) => item.risk === 'high').length,
    by_phase: byPhase,
  };
}
