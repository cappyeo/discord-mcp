import { createHash } from 'node:crypto';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord-api-types/v10';
import type { z } from 'zod';
import { validateComponentsV2 } from '../../components-v2/_lib/validator.js';
import type { BlueprintBindings } from './blueprint.execution.schema.js';
import type {
  BlueprintPermissionName,
  GuildBlueprint,
  PermissionOverwriteSchema,
} from './blueprint.schema.js';
import {
  channelType,
  type TargetOnboarding,
  type TargetWelcomeScreen,
} from './blueprint.target.js';
import { canonicalJson } from './blueprint.validation.js';

const PERMISSION_BITS: Record<BlueprintPermissionName, bigint> = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
  SEND_MESSAGES: PermissionFlagsBits.SendMessages,
  ADD_REACTIONS: PermissionFlagsBits.AddReactions,
  EMBED_LINKS: PermissionFlagsBits.EmbedLinks,
  ATTACH_FILES: PermissionFlagsBits.AttachFiles,
  USE_APPLICATION_COMMANDS: PermissionFlagsBits.UseApplicationCommands,
  CREATE_PUBLIC_THREADS: PermissionFlagsBits.CreatePublicThreads,
  SEND_MESSAGES_IN_THREADS: PermissionFlagsBits.SendMessagesInThreads,
  CONNECT: PermissionFlagsBits.Connect,
  SPEAK: PermissionFlagsBits.Speak,
  STREAM: PermissionFlagsBits.Stream,
  USE_VAD: PermissionFlagsBits.UseVAD,
  USE_EMBEDDED_ACTIVITIES: PermissionFlagsBits.UseEmbeddedActivities,
  MANAGE_MESSAGES: PermissionFlagsBits.ManageMessages,
  MANAGE_THREADS: PermissionFlagsBits.ManageThreads,
  VIEW_AUDIT_LOG: PermissionFlagsBits.ViewAuditLog,
  KICK_MEMBERS: PermissionFlagsBits.KickMembers,
  MODERATE_MEMBERS: PermissionFlagsBits.ModerateMembers,
  CREATE_EVENTS: PermissionFlagsBits.CreateEvents,
  MANAGE_EVENTS: PermissionFlagsBits.ManageEvents,
  MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
  MANAGE_ROLES: PermissionFlagsBits.ManageRoles,
  MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
  ADMINISTRATOR: PermissionFlagsBits.Administrator,
};

export interface DesiredOverwrite {
  readonly id: string;
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export function permissionBits(permissions: readonly BlueprintPermissionName[]): bigint {
  return permissions.reduce((bits, permission) => bits | PERMISSION_BITS[permission], 0n);
}

export function permissionNames(bits: bigint): BlueprintPermissionName[] {
  return (Object.entries(PERMISSION_BITS) as Array<[BlueprintPermissionName, bigint]>)
    .filter(([, permission]) => (bits & permission) === permission)
    .map(([name]) => name);
}

export function requiredBotPermissionBits(blueprint: GuildBlueprint): bigint {
  const names = new Set<BlueprintPermissionName>(
    blueprint.bot_boundary.always_required_permissions,
  );
  for (const role of blueprint.roles) {
    for (const permission of role.permissions) names.add(permission);
  }
  for (const item of [...blueprint.categories, ...blueprint.channels]) {
    for (const overwrite of item.overwrites) {
      for (const permission of overwrite.allow) names.add(permission);
    }
  }
  return permissionBits([...names]);
}

export function desiredRoleBody(role: GuildBlueprint['roles'][number]): Record<string, unknown> {
  return {
    name: role.name,
    permissions: permissionBits(role.permissions).toString(),
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
  };
}

function overwriteSubjectId(
  overwrite: z.infer<typeof PermissionOverwriteSchema>,
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): { id: string; type: number } | null {
  switch (overwrite.subject.kind) {
    case 'everyone':
      return { id: guildId, type: OverwriteType.Role };
    case 'bot':
      return { id: botId, type: OverwriteType.Member };
    case 'role': {
      const id = bindings.roles[overwrite.subject.key];
      return id === undefined ? null : { id, type: OverwriteType.Role };
    }
  }
}

export function desiredOverwrites(
  overwrites: readonly z.infer<typeof PermissionOverwriteSchema>[],
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): DesiredOverwrite[] | null {
  const result: DesiredOverwrite[] = [];
  for (const overwrite of overwrites) {
    const subject = overwriteSubjectId(overwrite, guildId, botId, bindings);
    if (subject === null) return null;
    result.push({
      ...subject,
      allow: permissionBits(overwrite.allow).toString(),
      deny: permissionBits(overwrite.deny).toString(),
    });
  }
  return result;
}

export function desiredCategoryBody(
  category: GuildBlueprint['categories'][number],
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): Record<string, unknown> | null {
  const permissionOverwrites = desiredOverwrites(category.overwrites, guildId, botId, bindings);
  if (permissionOverwrites === null) return null;
  return {
    name: category.name,
    type: ChannelType.GuildCategory,
    position: category.position,
    permission_overwrites: permissionOverwrites,
  };
}

export function desiredChannelBody(
  channel: GuildBlueprint['channels'][number],
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): Record<string, unknown> | null {
  const parentId = bindings.categories[channel.parent_key];
  if (parentId === undefined) return null;
  const permissionOverwrites = desiredOverwrites(channel.overwrites, guildId, botId, bindings);
  if (permissionOverwrites === null) return null;
  const body: Record<string, unknown> = {
    name: channel.name,
    type: channelType(channel.type),
    parent_id: parentId,
    position: channel.position,
    nsfw: false,
    rate_limit_per_user: channel.slowmode_seconds,
  };
  if (channel.topic !== null && (channel.type === 'text' || channel.type === 'forum')) {
    body.topic = channel.topic;
  }
  if (permissionOverwrites.length > 0) body.permission_overwrites = permissionOverwrites;
  if (channel.type === 'forum') {
    body.available_tags = channel.forum_tags.map((tag) => ({
      name: tag.name,
      moderated: tag.moderated,
      emoji_id: null,
      emoji_name: tag.emoji_name,
    }));
  }
  return body;
}

export function desiredGuildBody(
  blueprint: GuildBlueprint,
  currentFeatures: readonly string[],
  bindings: BlueprintBindings,
): Record<string, unknown> | null {
  const rulesChannelId = bindings.channels[blueprint.guild.community.rules_channel_key];
  const publicUpdatesChannelId =
    bindings.channels[blueprint.guild.community.public_updates_channel_key];
  const safetyAlertsChannelId =
    bindings.channels[blueprint.guild.community.safety_alerts_channel_key];
  if (
    rulesChannelId === undefined ||
    publicUpdatesChannelId === undefined ||
    safetyAlertsChannelId === undefined
  ) {
    return null;
  }
  return {
    name: blueprint.guild.name,
    description: blueprint.guild.description,
    preferred_locale: blueprint.guild.preferred_locale,
    verification_level: blueprint.guild.verification_level,
    default_message_notifications: blueprint.guild.default_message_notifications,
    explicit_content_filter: blueprint.guild.explicit_content_filter,
    rules_channel_id: rulesChannelId,
    public_updates_channel_id: publicUpdatesChannelId,
    safety_alerts_channel_id: safetyAlertsChannelId,
    features: [...new Set([...currentFeatures, 'COMMUNITY'])].sort(),
  };
}

export function desiredWelcomeBody(
  blueprint: GuildBlueprint,
  bindings: BlueprintBindings,
): Record<string, unknown> | null {
  const channels = new Map(blueprint.channels.map((channel) => [channel.key, channel]));
  const welcomeChannels: Array<Record<string, unknown>> = [];
  for (const key of blueprint.guild.welcome_screen.channel_keys) {
    const id = bindings.channels[key];
    const channel = channels.get(key);
    if (id === undefined || channel === undefined) return null;
    welcomeChannels.push({
      channel_id: id,
      description: (channel.topic ?? `Visit #${channel.name}`).slice(0, 50),
      emoji_id: null,
      emoji_name: '👋',
    });
  }
  return {
    enabled: blueprint.guild.welcome_screen.enabled,
    description: blueprint.guild.welcome_screen.description,
    welcome_channels: welcomeChannels,
  };
}

export function welcomeSemanticallyMatches(
  current: TargetWelcomeScreen,
  desired: Record<string, unknown>,
): boolean {
  const normalized = {
    description: current.description,
    welcome_channels: current.welcome_channels.map((channel) => ({
      channel_id: channel.channel_id,
      description: channel.description,
      emoji_id: channel.emoji_id,
      emoji_name: channel.emoji_name,
    })),
  };
  return (
    canonicalJson(normalized) ===
    canonicalJson({
      description: desired.description,
      welcome_channels: desired.welcome_channels,
    })
  );
}

export function desiredOnboardingBody(
  blueprint: GuildBlueprint,
  bindings: BlueprintBindings,
  current?: TargetOnboarding | null,
): Record<string, unknown> | null {
  const defaultChannelIds = blueprint.onboarding.default_channel_keys.map(
    (key) => bindings.channels[key],
  );
  if (defaultChannelIds.some((id) => id === undefined)) return null;
  const prompts: Array<Record<string, unknown>> = [];
  for (const prompt of blueprint.onboarding.prompts) {
    const currentPromptMatches = (current?.prompts ?? []).filter(
      (candidate) => candidate.title === prompt.title,
    );
    const currentPrompt = currentPromptMatches.length === 1 ? currentPromptMatches[0] : undefined;
    const currentOptions = Array.isArray(currentPrompt?.options) ? currentPrompt.options : [];
    const options: Array<Record<string, unknown>> = [];
    for (const option of prompt.options) {
      const roleIds = option.role_keys.map((key) => bindings.roles[key]);
      const channelIds = option.channel_keys.map((key) => bindings.channels[key]);
      if (roleIds.some((id) => id === undefined) || channelIds.some((id) => id === undefined)) {
        return null;
      }
      const currentOptionMatches = currentOptions.filter(
        (candidate) =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as Record<string, unknown>).title === option.title,
      );
      const currentOption =
        currentOptionMatches.length === 1
          ? (currentOptionMatches[0] as Record<string, unknown>)
          : undefined;
      const currentOptionId = currentOption?.id;
      options.push({
        ...(typeof currentOptionId === 'string' && /^\d{17,20}$/.test(currentOptionId)
          ? { id: currentOptionId }
          : {}),
        title: option.title,
        description: option.description,
        role_ids: roleIds,
        channel_ids: channelIds,
        emoji_id: null,
        emoji_name: null,
        emoji_animated: false,
      });
    }
    const currentPromptId = currentPrompt?.id;
    // Discord currently requires a prompt snowflake even for a new prompt but
    // ignores that placeholder and returns the authoritative created ID. This
    // mirrors discord.js Guild#editOnboarding instead of exposing the quirk to
    // the blueprint model.
    const entropy =
      BigInt(`0x${createHash('sha256').update(prompt.key).digest('hex').slice(0, 6)}`) & 0x3f_ffffn;
    const placeholderId = ((BigInt(Date.now() - 1_420_070_400_000) << 22n) | entropy).toString();
    prompts.push({
      id:
        typeof currentPromptId === 'string' && /^\d{17,20}$/.test(currentPromptId)
          ? currentPromptId
          : placeholderId,
      type: prompt.type,
      title: prompt.title,
      single_select: prompt.single_select,
      required: prompt.required,
      in_onboarding: prompt.in_onboarding,
      options,
    });
  }
  return {
    prompts,
    default_channel_ids: defaultChannelIds,
    enabled: blueprint.onboarding.enabled,
    mode: blueprint.onboarding.mode,
  };
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

export function onboardingResponseHasIds(onboarding: TargetOnboarding): boolean {
  return onboarding.prompts.every(
    (prompt) =>
      typeof prompt.id === 'string' &&
      /^\d{17,20}$/.test(prompt.id) &&
      Array.isArray(prompt.options) &&
      prompt.options.every(
        (option) =>
          typeof option === 'object' &&
          option !== null &&
          typeof (option as Record<string, unknown>).id === 'string' &&
          /^\d{17,20}$/.test((option as Record<string, unknown>).id as string),
      ),
  );
}

export function onboardingSemanticallyMatches(
  current: TargetOnboarding | null,
  desired: Record<string, unknown>,
): boolean {
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

function triggerMetadata(rule: GuildBlueprint['automod']['rules'][number]) {
  switch (rule.trigger_type) {
    case 1:
    case 6:
      return {
        keyword_filter: rule.keyword_filter,
        regex_patterns: rule.regex_patterns,
        allow_list: rule.allow_list,
      };
    case 3:
      return {};
    case 4:
      return { presets: rule.presets, allow_list: rule.allow_list };
    case 5:
      return {
        mention_total_limit: rule.mention_total_limit,
        mention_raid_protection_enabled: rule.mention_raid_protection_enabled,
      };
  }
}

export function desiredAutoModBody(
  rule: GuildBlueprint['automod']['rules'][number],
  bindings: BlueprintBindings,
): Record<string, unknown> | null {
  const exemptRoles = rule.exempt_role_keys.map((key) => bindings.roles[key]);
  const exemptChannels = rule.exempt_channel_keys.map((key) => bindings.channels[key]);
  if (exemptRoles.some((id) => id === undefined) || exemptChannels.some((id) => id === undefined)) {
    return null;
  }
  const actions: Array<Record<string, unknown>> = [];
  for (const action of rule.actions) {
    const metadata: Record<string, unknown> = {};
    if (action.alert_channel_key !== null) {
      const channelId = bindings.channels[action.alert_channel_key];
      if (channelId === undefined) return null;
      metadata.channel_id = channelId;
    }
    if (action.duration_seconds !== null) metadata.duration_seconds = action.duration_seconds;
    if (action.custom_message !== null) metadata.custom_message = action.custom_message;
    actions.push({
      type: action.type,
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    });
  }
  return {
    name: rule.name,
    event_type: rule.event_type,
    trigger_type: rule.trigger_type,
    trigger_metadata: triggerMetadata(rule),
    actions,
    enabled: rule.enabled,
    exempt_roles: exemptRoles,
    exempt_channels: exemptChannels,
  };
}

export function publicationMarker(blueprintId: string, publicationKey: string): string {
  return `-# Managed by discord-mcp · blueprint ${blueprintId.slice(7, 19)} · publication ${publicationKey}`;
}

function replaceChannelSymbols(value: unknown, bindings: BlueprintBindings): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{channel:([a-z][a-z0-9_]{0,63})\}\}/g, (_match, key: string) => {
      const id = bindings.channels[key];
      if (id === undefined) throw new Error(`Unresolved channel symbol: ${key}`);
      return id;
    });
  }
  if (Array.isArray(value)) return value.map((item) => replaceChannelSymbols(item, bindings));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceChannelSymbols(item, bindings)]),
    );
  }
  return value;
}

function appendMarker(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (appendMarker(item, marker)) return true;
    }
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 10 && typeof record.content === 'string') {
    record.content = `${record.content}\n\n${marker}`;
    return true;
  }
  return appendMarker(record.components, marker);
}

export function desiredPublicationBody(
  publication: GuildBlueprint['components_v2']['publications'][number],
  blueprintId: string,
  guildId: string,
  botId: string,
  bindings: BlueprintBindings,
): { channel_id: string; body: Record<string, unknown>; marker: string } | null {
  const channelId = bindings.channels[publication.channel_key];
  if (channelId === undefined) return null;
  const components = replaceChannelSymbols(
    structuredClone(publication.components),
    bindings,
  ) as unknown[];
  const marker = publicationMarker(blueprintId, publication.key);
  if (!appendMarker(components, marker)) return null;
  const validation = validateComponentsV2(components);
  if (!validation.valid) return null;
  const nonce = `dmc${createHash('sha256')
    .update(`${guildId}\0${botId}\0${channelId}\0${blueprintId}\0${publication.key}`)
    .digest('hex')
    .slice(0, 22)}`;
  return {
    channel_id: channelId,
    marker,
    body: {
      flags: 32_768,
      components,
      allowed_mentions: publication.allowed_mentions,
      nonce,
      enforce_nonce: true,
    },
  };
}
