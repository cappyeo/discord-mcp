import { PermissionFlagsBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { GuildId, UserId } from '../../_lib/snowflake.js';
import { wrapUntrusted } from '../../_lib/untrusted.js';

export const TemplateCode = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Template code may contain only letters, numbers, underscores, and hyphens.',
  );

export interface RawGuildTemplate {
  code: string;
  name: string;
  description: string | null;
  usage_count: number;
  creator_id: string;
  created_at: string;
  updated_at: string;
  source_guild_id: string;
  is_dirty?: boolean | null;
  serialized_source_guild?: Record<string, unknown>;
}

export const TemplateSummarySchema = z.object({
  code: TemplateCode,
  name: z.string(),
  description: z.string().nullable(),
  usage_count: z.number().int().nonnegative(),
  creator_id: UserId,
  created_at: z.string(),
  updated_at: z.string(),
  source_guild_id: GuildId,
  is_dirty: z.boolean().nullable(),
  use_url: z.string().url(),
});

const RiskyPermissionSchema = z.enum([
  'ADMINISTRATOR',
  'MANAGE_GUILD',
  'MANAGE_ROLES',
  'MANAGE_CHANNELS',
  'MANAGE_WEBHOOKS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'MENTION_EVERYONE',
]);

export const TemplateBlueprintSchema = z.object({
  channel_count: z.number().int().nonnegative(),
  category_count: z.number().int().nonnegative(),
  text_channel_count: z.number().int().nonnegative(),
  voice_channel_count: z.number().int().nonnegative(),
  forum_channel_count: z.number().int().nonnegative(),
  stage_channel_count: z.number().int().nonnegative(),
  other_channel_count: z.number().int().nonnegative(),
  nsfw_channel_count: z.number().int().nonnegative(),
  permission_overwrite_count: z.number().int().nonnegative(),
  role_count: z.number().int().nonnegative(),
  privileged_role_count: z.number().int().nonnegative(),
  risky_permission_signals: z.array(
    z.object({ permission: RiskyPermissionSchema, role_count: z.number().int().positive() }),
  ),
});

export const TemplateDriftSchema = z.object({
  template_channel_count: z.number().int().nonnegative(),
  source_guild_channel_count: z.number().int().nonnegative(),
  channels_missing_from_guild_count: z.number().int().nonnegative(),
  channels_added_since_snapshot_count: z.number().int().nonnegative(),
  template_role_count: z.number().int().nonnegative(),
  source_guild_role_count: z.number().int().nonnegative(),
  roles_missing_from_guild_count: z.number().int().nonnegative(),
  roles_added_since_snapshot_count: z.number().int().nonnegative(),
  role_permission_difference_count: z.number().int().nonnegative(),
  channel_setting_difference_count: z.number().int().nonnegative(),
  permission_overwrite_difference_count: z.number().int().nonnegative(),
  unmapped_permission_overwrite_count: z.number().int().nonnegative(),
  template_marked_dirty: z.boolean().nullable(),
  sync_recommended: z.boolean(),
});

type TemplateSourceRecord = Record<string, unknown>;

interface NamedTemplateItem {
  readonly record: TemplateSourceRecord;
  readonly name: string;
  readonly type: number | undefined;
}

interface MatchedItemPair {
  readonly expected: NamedTemplateItem;
  readonly actual: NamedTemplateItem;
}

const RISKY_PERMISSION_FLAGS = [
  ['ADMINISTRATOR', PermissionFlagsBits.Administrator],
  ['MANAGE_GUILD', PermissionFlagsBits.ManageGuild],
  ['MANAGE_ROLES', PermissionFlagsBits.ManageRoles],
  ['MANAGE_CHANNELS', PermissionFlagsBits.ManageChannels],
  ['MANAGE_WEBHOOKS', PermissionFlagsBits.ManageWebhooks],
  ['KICK_MEMBERS', PermissionFlagsBits.KickMembers],
  ['BAN_MEMBERS', PermissionFlagsBits.BanMembers],
  ['MENTION_EVERYONE', PermissionFlagsBits.MentionEveryone],
] as const;

function records(value: unknown): TemplateSourceRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is TemplateSourceRecord => typeof item === 'object' && item !== null,
      )
    : [];
}

function sourceGuild(template: RawGuildTemplate): TemplateSourceRecord {
  return template.serialized_source_guild ?? {};
}

function sourceChannels(template: RawGuildTemplate): TemplateSourceRecord[] {
  return records(sourceGuild(template).channels);
}

function sourceRoles(template: RawGuildTemplate): TemplateSourceRecord[] {
  return records(sourceGuild(template).roles);
}

function hasPermission(value: unknown, flag: bigint): boolean {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  return (BigInt(value) & flag) === flag;
}

function itemName(item: TemplateSourceRecord, index: number): string {
  return typeof item.name === 'string' ? item.name : `[unnamed ${index + 1}]`;
}

function itemType(item: TemplateSourceRecord): number | undefined {
  return typeof item.type === 'number' && Number.isInteger(item.type) ? item.type : undefined;
}

export function templateBlueprint(template: RawGuildTemplate) {
  const channels = sourceChannels(template);
  const roles = sourceRoles(template);
  const signalCounts = new Map<(typeof RISKY_PERMISSION_FLAGS)[number][0], number>();
  let privilegedRoleCount = 0;

  for (const role of roles) {
    let hasRiskyPermission = false;
    for (const [permission, flag] of RISKY_PERMISSION_FLAGS) {
      if (!hasPermission(role.permissions, flag)) continue;
      signalCounts.set(permission, (signalCounts.get(permission) ?? 0) + 1);
      hasRiskyPermission = true;
    }
    if (hasRiskyPermission) privilegedRoleCount += 1;
  }

  const count = (type: number) => channels.filter((channel) => channel.type === type).length;
  const knownChannelCount = [0, 2, 4, 13, 15].reduce((total, type) => total + count(type), 0);
  return {
    channel_count: channels.length,
    category_count: count(4),
    text_channel_count: count(0),
    voice_channel_count: count(2),
    forum_channel_count: count(15),
    stage_channel_count: count(13),
    other_channel_count: channels.length - knownChannelCount,
    nsfw_channel_count: channels.filter((channel) => channel.nsfw === true).length,
    permission_overwrite_count: channels.reduce(
      (total, channel) => total + records(channel.permission_overwrites).length,
      0,
    ),
    role_count: roles.length,
    privileged_role_count: privilegedRoleCount,
    risky_permission_signals: RISKY_PERMISSION_FLAGS.flatMap(([permission]) => {
      const roleCount = signalCounts.get(permission);
      return roleCount === undefined ? [] : [{ permission, role_count: roleCount }];
    }),
  };
}

function namedItems(items: readonly TemplateSourceRecord[]): NamedTemplateItem[] {
  return items.map((record, index) => ({
    record,
    name: itemName(record, index),
    type: itemType(record),
  }));
}

function itemKey(item: NamedTemplateItem, includeType: boolean): string {
  return `${includeType ? `${item.type ?? 'unknown'}:` : ''}${item.name.trim().toLowerCase()}`;
}

function matchingPairs(
  expected: readonly NamedTemplateItem[],
  actual: readonly NamedTemplateItem[],
  includeType: boolean,
  score?: (expected: NamedTemplateItem, actual: NamedTemplateItem) => number,
): MatchedItemPair[] {
  const available = new Map<string, NamedTemplateItem[]>();
  for (const item of actual) {
    const key = itemKey(item, includeType);
    const existing = available.get(key) ?? [];
    existing.push(item);
    available.set(key, existing);
  }

  const pairs: MatchedItemPair[] = [];
  for (const item of expected) {
    const matches = available.get(itemKey(item, includeType));
    if (matches === undefined || matches.length === 0) continue;
    let match: NamedTemplateItem | undefined;
    if (score === undefined) {
      match = matches.shift();
    } else {
      let bestIndex = 0;
      let bestScore = score(item, matches[0]!);
      for (let index = 1; index < matches.length; index += 1) {
        const candidateScore = score(item, matches[index]!);
        if (candidateScore <= bestScore) continue;
        bestIndex = index;
        bestScore = candidateScore;
      }
      match = matches.splice(bestIndex, 1)[0];
    }
    if (match !== undefined) pairs.push({ expected: item, actual: match });
  }
  return pairs;
}

function difference(
  expected: readonly NamedTemplateItem[],
  actual: readonly NamedTemplateItem[],
  includeType: boolean,
): { missing: string[]; added: string[] } {
  const available = new Map<string, number>();
  for (const item of actual) {
    const key = itemKey(item, includeType);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const item of expected) {
    const key = itemKey(item, includeType);
    const count = available.get(key) ?? 0;
    if (count === 0) missing.push(item.name);
    else available.set(key, count - 1);
  }

  const expectedCounts = new Map<string, number>();
  for (const item of expected) {
    const key = itemKey(item, includeType);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const item of actual) {
    const key = itemKey(item, includeType);
    const count = expectedCounts.get(key) ?? 0;
    if (count === 0) added.push(item.name);
    else expectedCounts.set(key, count - 1);
  }
  return { missing, added };
}

const CHANNEL_SETTING_FIELDS = [
  'nsfw',
  'topic',
  'rate_limit_per_user',
  'bitrate',
  'user_limit',
  'rtc_region',
  'video_quality_mode',
  'default_auto_archive_duration',
  'default_thread_rate_limit_per_user',
  'default_forum_layout',
  'default_sort_order',
  'default_reaction_emoji',
  'available_tags',
  'flags',
] as const;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function changedChannelSettings(
  expected: TemplateSourceRecord,
  actual: TemplateSourceRecord,
): string[] {
  return CHANNEL_SETTING_FIELDS.filter((field) => {
    // A missing optional field can be Discord's serialization default. Only
    // call out a drift when both snapshots explicitly carry the setting.
    if (expected[field] === undefined || actual[field] === undefined) return false;
    return stableJson(expected[field]) !== stableJson(actual[field]);
  });
}

function channelPairSimilarity(expected: NamedTemplateItem, actual: NamedTemplateItem): number {
  return CHANNEL_SETTING_FIELDS.reduce((score, field) => {
    if (expected.record[field] === undefined || actual.record[field] === undefined) return score;
    return stableJson(expected.record[field]) === stableJson(actual.record[field])
      ? score + 1
      : score;
  }, 0);
}

function roleSubjects(roles: readonly TemplateSourceRecord[]): Map<string, string> {
  const namedRoles = roles.map((role, index) => ({
    id: typeof role.id === 'string' || typeof role.id === 'number' ? String(role.id) : undefined,
    name: itemName(role, index).trim().toLowerCase(),
  }));
  const nameCounts = new Map<string, number>();
  for (const role of namedRoles) {
    nameCounts.set(role.name, (nameCounts.get(role.name) ?? 0) + 1);
  }
  const subjects = new Map<string, string>();
  for (const role of namedRoles) {
    if (role.id === undefined || nameCounts.get(role.name) !== 1) continue;
    subjects.set(role.id, `role:${role.name}`);
  }
  return subjects;
}

function canonicalOverwrites(
  channel: TemplateSourceRecord,
  roles: ReadonlyMap<string, string>,
): { entries: Map<string, string>; unmappedCount: number } {
  const entries = new Map<string, string>();
  let unmappedCount = 0;
  for (const overwrite of records(channel.permission_overwrites)) {
    const id =
      typeof overwrite.id === 'string' || typeof overwrite.id === 'number'
        ? String(overwrite.id)
        : undefined;
    const type = overwrite.type;
    let subject: string | undefined;
    if (type === 0 && id !== undefined) subject = roles.get(id);
    else if (type === 1 && id !== undefined) subject = `member:${id}`;
    if (subject === undefined) {
      unmappedCount += 1;
      continue;
    }
    entries.set(subject, `${String(overwrite.allow ?? '0')}:${String(overwrite.deny ?? '0')}`);
  }
  return { entries, unmappedCount };
}

function overwriteDifference(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
): number {
  const subjects = new Set([...expected.keys(), ...actual.keys()]);
  let differences = 0;
  for (const subject of subjects) {
    if (expected.get(subject) !== actual.get(subject)) differences += 1;
  }
  return differences;
}

export function templateDrift(
  template: RawGuildTemplate,
  currentChannels: readonly TemplateSourceRecord[],
  currentRoles: readonly TemplateSourceRecord[],
) {
  const templateChannels = sourceChannels(template);
  const templateRoles = sourceRoles(template);
  // Guild Templates do not serialize bot/integration roles. Counting those
  // managed roles as additions would permanently recommend a no-op sync.
  const comparableCurrentRoles = currentRoles.filter((role) => role.managed !== true);
  const channelDifference = difference(
    namedItems(templateChannels),
    namedItems(currentChannels),
    true,
  );
  const roleDifference = difference(
    namedItems(templateRoles),
    namedItems(comparableCurrentRoles),
    false,
  );
  const rolePairs = matchingPairs(
    namedItems(templateRoles),
    namedItems(comparableCurrentRoles),
    false,
    (expected, actual) => (expected.record.permissions === actual.record.permissions ? 1 : 0),
  );
  // Discord permits duplicate names. Pair by comparable settings first, not
  // by the API's arbitrary result order, so a same-name channel's overwrite
  // and topic are evaluated against its actual counterpart.
  const channelPairs = matchingPairs(
    namedItems(templateChannels),
    namedItems(currentChannels),
    true,
    channelPairSimilarity,
  );
  const rolePermissionChanges = rolePairs.filter(
    ({ expected, actual }) => expected.record.permissions !== actual.record.permissions,
  );
  const channelSettingChanges = channelPairs.flatMap(({ expected, actual }) => {
    const fields = changedChannelSettings(expected.record, actual.record);
    return fields.length === 0 ? [] : [{ name: expected.name, fields }];
  });
  const templateRoleSubjects = roleSubjects(templateRoles);
  const currentRoleSubjects = roleSubjects(comparableCurrentRoles);
  const overwriteChanges = channelPairs.map(({ expected, actual }) => {
    const templateOverwrites = canonicalOverwrites(expected.record, templateRoleSubjects);
    const currentOverwrites = canonicalOverwrites(actual.record, currentRoleSubjects);
    return {
      name: expected.name,
      differenceCount: overwriteDifference(templateOverwrites.entries, currentOverwrites.entries),
      unmappedCount: templateOverwrites.unmappedCount + currentOverwrites.unmappedCount,
    };
  });
  const rolePermissionDifferenceCount = rolePermissionChanges.length;
  const channelSettingDifferenceCount = channelSettingChanges.reduce(
    (total, change) => total + change.fields.length,
    0,
  );
  const permissionOverwriteDifferenceCount = overwriteChanges.reduce(
    (total, change) => total + change.differenceCount,
    0,
  );
  const unmappedPermissionOverwriteCount = overwriteChanges.reduce(
    (total, change) => total + change.unmappedCount,
    0,
  );
  const templateMarkedDirty = template.is_dirty ?? null;
  return {
    drift: {
      template_channel_count: templateChannels.length,
      source_guild_channel_count: currentChannels.length,
      channels_missing_from_guild_count: channelDifference.missing.length,
      channels_added_since_snapshot_count: channelDifference.added.length,
      template_role_count: templateRoles.length,
      source_guild_role_count: comparableCurrentRoles.length,
      roles_missing_from_guild_count: roleDifference.missing.length,
      roles_added_since_snapshot_count: roleDifference.added.length,
      role_permission_difference_count: rolePermissionDifferenceCount,
      channel_setting_difference_count: channelSettingDifferenceCount,
      permission_overwrite_difference_count: permissionOverwriteDifferenceCount,
      unmapped_permission_overwrite_count: unmappedPermissionOverwriteCount,
      template_marked_dirty: templateMarkedDirty,
      sync_recommended:
        templateMarkedDirty === true ||
        channelDifference.missing.length > 0 ||
        channelDifference.added.length > 0 ||
        roleDifference.missing.length > 0 ||
        roleDifference.added.length > 0 ||
        rolePermissionDifferenceCount > 0 ||
        channelSettingDifferenceCount > 0 ||
        permissionOverwriteDifferenceCount > 0 ||
        unmappedPermissionOverwriteCount > 0,
    },
    details: {
      channels_missing_from_guild: channelDifference.missing.slice(0, 25),
      channels_added_since_snapshot: channelDifference.added.slice(0, 25),
      roles_missing_from_guild: roleDifference.missing.slice(0, 25),
      roles_added_since_snapshot: roleDifference.added.slice(0, 25),
      roles_with_permission_changes: rolePermissionChanges
        .map(({ expected }) => expected.name)
        .slice(0, 25),
      channels_with_setting_changes: channelSettingChanges.slice(0, 25),
      channels_with_permission_overwrite_changes: overwriteChanges
        .filter(({ differenceCount, unmappedCount }) => differenceCount > 0 || unmappedCount > 0)
        .slice(0, 25),
    },
  };
}

export function summarizeTemplate(template: RawGuildTemplate) {
  return {
    code: template.code,
    name: template.name,
    description: template.description,
    usage_count: template.usage_count,
    creator_id: template.creator_id,
    created_at: template.created_at,
    updated_at: template.updated_at,
    source_guild_id: template.source_guild_id,
    is_dirty: template.is_dirty ?? null,
    use_url: `https://discord.new/${encodeURIComponent(template.code)}`,
  };
}

export function templateUntrustedText(template: RawGuildTemplate): string {
  return wrapUntrusted(
    JSON.stringify({
      name: template.name,
      description: template.description,
      serialized_source_guild: template.serialized_source_guild,
    }),
    'template',
  );
}

export function templatesUntrustedText(templates: readonly RawGuildTemplate[]): string {
  return wrapUntrusted(
    JSON.stringify(templates.map(({ name, description }) => ({ name, description }))),
    'template',
  );
}

export function templateDriftUntrustedText(details: Record<string, unknown>): string {
  return wrapUntrusted(JSON.stringify(details), 'template');
}
