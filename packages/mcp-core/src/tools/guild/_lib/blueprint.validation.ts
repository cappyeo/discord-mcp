import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { validateComponentsV2 } from '../../components-v2/_lib/validator.js';
import {
  type BlueprintPermissionName,
  type GuildBlueprint,
  GuildBlueprintSchema,
  type PermissionOverwriteSchema,
  SymbolKey,
} from './blueprint.schema.js';

const FORBIDDEN_USER_ROLE_PERMISSIONS = new Set<BlueprintPermissionName>([
  'ADMINISTRATOR',
  'MANAGE_GUILD',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
]);
const INVALID_OVERWRITE_PERMISSIONS = new Set<BlueprintPermissionName>([
  'ADMINISTRATOR',
  'MANAGE_GUILD',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'VIEW_AUDIT_LOG',
  'KICK_MEMBERS',
  'MODERATE_MEMBERS',
  'CREATE_EVENTS',
  'MANAGE_EVENTS',
]);
const STAFF_OVERWRITE_PERMISSIONS = new Set<BlueprintPermissionName>([
  'MANAGE_MESSAGES',
  'MANAGE_THREADS',
]);

function subjectKey(subject: z.infer<typeof PermissionOverwriteSchema>['subject']): string {
  return subject.kind === 'role' ? `role:${subject.key}` : subject.kind;
}

function duplicateValues(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function assertPermissionSet(
  permissions: readonly BlueprintPermissionName[],
  context: string,
): void {
  if (duplicateValues(permissions)) throw new Error(`${context} contains duplicate permissions.`);
}

function assertOverwrite(
  overwrite: z.infer<typeof PermissionOverwriteSchema>,
  context: string,
): void {
  assertPermissionSet(overwrite.allow, `${context}.allow`);
  assertPermissionSet(overwrite.deny, `${context}.deny`);
  const denied = new Set(overwrite.deny);
  if (overwrite.allow.some((permission) => denied.has(permission))) {
    throw new Error(`${context} allows and denies the same permission.`);
  }
  if (
    [...overwrite.allow, ...overwrite.deny].some((permission) =>
      INVALID_OVERWRITE_PERMISSIONS.has(permission),
    )
  ) {
    throw new Error(`${context} contains a permission that is invalid in an overwrite.`);
  }
  const staffSubject =
    overwrite.subject.kind === 'bot' ||
    (overwrite.subject.kind === 'role' &&
      (overwrite.subject.key === 'helper' || overwrite.subject.key === 'moderator'));
  if (
    !staffSubject &&
    overwrite.allow.some((permission) => STAFF_OVERWRITE_PERMISSIONS.has(permission))
  ) {
    throw new Error(`${context} grants a staff-only channel permission to a public subject.`);
  }
  const allowed = new Set(overwrite.allow);
  if (
    allowed.has('CREATE_PUBLIC_THREADS') &&
    (!allowed.has('VIEW_CHANNEL') || !allowed.has('SEND_MESSAGES'))
  ) {
    throw new Error(`${context} creates threads without view/send prerequisites.`);
  }
  if (
    (allowed.has('EMBED_LINKS') || allowed.has('ATTACH_FILES')) &&
    !allowed.has('SEND_MESSAGES')
  ) {
    throw new Error(`${context} embeds or attaches without SEND_MESSAGES.`);
  }
  if (
    ['SPEAK', 'STREAM', 'USE_VAD', 'USE_EMBEDDED_ACTIVITIES'].some((permission) =>
      allowed.has(permission as BlueprintPermissionName),
    ) &&
    !allowed.has('CONNECT')
  ) {
    throw new Error(`${context} grants voice actions without CONNECT.`);
  }
}

function everyoneCan(
  channel: GuildBlueprint['channels'][number],
  parent: GuildBlueprint['categories'][number],
  permission: BlueprintPermissionName,
): boolean {
  const parentOverwrite = parent.overwrites.find(
    (overwrite) => overwrite.subject.kind === 'everyone',
  );
  let allowed = parentOverwrite?.allow.includes(permission) ?? false;
  if (parentOverwrite?.deny.includes(permission)) allowed = false;
  const channelOverwrite = channel.overwrites.find(
    (overwrite) => overwrite.subject.kind === 'everyone',
  );
  if (channelOverwrite?.deny.includes(permission)) return false;
  if (channelOverwrite?.allow.includes(permission)) return true;
  return allowed;
}

export function assertBlueprintSafe(blueprint: GuildBlueprint): void {
  GuildBlueprintSchema.parse(blueprint);
  const roles = new Map(blueprint.roles.map((item) => [item.key, item]));
  const categories = new Map(blueprint.categories.map((item) => [item.key, item]));
  const channels = new Map(blueprint.channels.map((item) => [item.key, item]));
  if (roles.size !== blueprint.roles.length) throw new Error('Role keys must be unique.');
  if (categories.size !== blueprint.categories.length) {
    throw new Error('Category keys must be unique.');
  }
  if (channels.size !== blueprint.channels.length) throw new Error('Channel keys must be unique.');
  if (
    new Set([...categories.keys(), ...channels.keys()]).size !==
    categories.size + channels.size
  ) {
    throw new Error('Category and channel keys must not overlap.');
  }
  const communityChannels = [
    blueprint.guild.community.rules_channel_key,
    blueprint.guild.community.public_updates_channel_key,
    blueprint.guild.community.safety_alerts_channel_key,
  ];
  if (communityChannels.some((key) => !channels.has(key))) {
    throw new Error('Community settings reference an unknown channel.');
  }
  for (const [purpose, key] of [
    ['rules', blueprint.guild.community.rules_channel_key],
    ['public updates', blueprint.guild.community.public_updates_channel_key],
  ] as const) {
    const channel = channels.get(key)!;
    if (channel.type !== 'text' || categories.get(channel.parent_key)?.private) {
      throw new Error(`Community ${purpose} must use a public text channel.`);
    }
  }
  if (
    duplicateValues(blueprint.guild.welcome_screen.channel_keys) ||
    blueprint.guild.welcome_screen.channel_keys.some((key) => !channels.has(key))
  ) {
    throw new Error('Welcome Screen must reference unique known channels.');
  }
  if (
    blueprint.guild.welcome_screen.channel_keys.some((key) => {
      const channel = channels.get(key)!;
      const parent = categories.get(channel.parent_key)!;
      return (
        parent.private ||
        (channel.type !== 'text' && channel.type !== 'forum') ||
        !everyoneCan(channel, parent, 'VIEW_CHANNEL')
      );
    })
  ) {
    throw new Error('Welcome Screen must use public, everyone-visible text or forum channels.');
  }
  const safetyAlerts = channels.get(blueprint.guild.community.safety_alerts_channel_key);
  if (
    safetyAlerts === undefined ||
    safetyAlerts.type !== 'text' ||
    !categories.get(safetyAlerts.parent_key)?.private
  ) {
    throw new Error('Community safety alerts must use a private text channel.');
  }
  if (duplicateValues(blueprint.role_order)) throw new Error('Role order must be unique.');
  if (blueprint.role_order.length !== blueprint.roles.length) {
    throw new Error('Role order must contain every generated role exactly once.');
  }
  for (const [index, key] of blueprint.role_order.entries()) {
    const item = roles.get(key);
    if (item === undefined || item.position !== index + 1) {
      throw new Error('Role positions must strictly follow role_order.');
    }
  }
  for (const item of blueprint.roles) {
    assertPermissionSet(item.permissions, `role:${item.key}`);
    if (item.permissions.some((permission) => FORBIDDEN_USER_ROLE_PERMISSIONS.has(permission))) {
      throw new Error(`Role ${item.key} contains a forbidden permission.`);
    }
  }
  for (const item of blueprint.categories) {
    const targets = item.overwrites.map((overwrite) => subjectKey(overwrite.subject));
    if (duplicateValues(targets)) throw new Error(`Category ${item.key} has duplicate overwrites.`);
    for (const overwrite of item.overwrites) {
      assertOverwrite(overwrite, `category:${item.key}:${subjectKey(overwrite.subject)}`);
      if (overwrite.subject.kind === 'role' && !roles.has(overwrite.subject.key)) {
        throw new Error(`Category ${item.key} references an unknown role.`);
      }
    }
    if (item.private) {
      const publicDeny = item.overwrites.find((overwrite) => overwrite.subject.kind === 'everyone');
      if (!publicDeny?.deny.includes('VIEW_CHANNEL')) {
        throw new Error(`Private category ${item.key} must deny VIEW_CHANNEL to everyone.`);
      }
      for (const staffKey of ['helper', 'moderator']) {
        const staffAllow = item.overwrites.find(
          (overwrite) => overwrite.subject.kind === 'role' && overwrite.subject.key === staffKey,
        );
        if (!staffAllow?.allow.includes('VIEW_CHANNEL')) {
          throw new Error(`Private category ${item.key} must allow ${staffKey} to view it.`);
        }
      }
    }
  }
  for (const item of blueprint.channels) {
    const parent = categories.get(item.parent_key);
    if (parent === undefined) {
      throw new Error(`Channel ${item.key} references an unknown category.`);
    }
    const targets = item.overwrites.map((overwrite) => subjectKey(overwrite.subject));
    if (duplicateValues(targets)) throw new Error(`Channel ${item.key} has duplicate overwrites.`);
    for (const overwrite of item.overwrites) {
      assertOverwrite(overwrite, `channel:${item.key}:${subjectKey(overwrite.subject)}`);
      if (overwrite.subject.kind === 'role' && !roles.has(overwrite.subject.key)) {
        throw new Error(`Channel ${item.key} references an unknown role.`);
      }
      if (
        parent.private &&
        (overwrite.subject.kind === 'everyone' ||
          (overwrite.subject.kind === 'role' && overwrite.subject.key === 'member')) &&
        overwrite.allow.includes('VIEW_CHANNEL')
      ) {
        throw new Error(`Channel ${item.key} leaks a private category to public members.`);
      }
    }
    const canEveryoneSend = everyoneCan(item, parent, 'SEND_MESSAGES');
    if (item.everyone_sendable !== canEveryoneSend) {
      throw new Error(
        `Channel ${item.key} everyone_sendable does not match effective SEND_MESSAGES.`,
      );
    }
  }
  const defaults = blueprint.onboarding.default_channel_keys;
  if (duplicateValues(defaults)) throw new Error('Onboarding default channels must be unique.');
  if (defaults.some((key) => !channels.has(key))) {
    throw new Error('Onboarding references an unknown default channel.');
  }
  if (defaults.some((key) => channels.get(key)?.default_onboarding !== true)) {
    throw new Error('Every onboarding default must be marked default_onboarding.');
  }
  if (
    defaults.some((key) => {
      const channel = channels.get(key)!;
      const parent = categories.get(channel.parent_key)!;
      return (
        parent.private ||
        (channel.type !== 'text' && channel.type !== 'forum') ||
        !everyoneCan(channel, parent, 'VIEW_CHANNEL')
      );
    })
  ) {
    throw new Error('Onboarding defaults must be public, everyone-visible text or forum channels.');
  }
  const sendableDefaults = defaults.filter((key) => channels.get(key)?.everyone_sendable).length;
  if (defaults.length < 7 || sendableDefaults < 5) {
    throw new Error('Onboarding requires 7 defaults with 5 everyone-sendable channels.');
  }
  if (duplicateValues(blueprint.onboarding.prompts.map((prompt) => prompt.key))) {
    throw new Error('Onboarding prompt keys must be unique.');
  }
  for (const prompt of blueprint.onboarding.prompts) {
    if (duplicateValues(prompt.options.map((option) => option.key))) {
      throw new Error(`Onboarding prompt ${prompt.key} has duplicate option keys.`);
    }
    for (const option of prompt.options) {
      if (option.role_keys.some((key) => !roles.has(key))) {
        throw new Error(`Onboarding option ${option.key} references an unknown role.`);
      }
      if (option.channel_keys.some((key) => !channels.has(key))) {
        throw new Error(`Onboarding option ${option.key} references an unknown channel.`);
      }
    }
  }
  const triggerCounts = new Map<number, number>();
  if (duplicateValues(blueprint.automod.rules.map((rule) => rule.key))) {
    throw new Error('AutoMod rule keys must be unique.');
  }
  for (const rule of blueprint.automod.rules) {
    triggerCounts.set(rule.trigger_type, (triggerCounts.get(rule.trigger_type) ?? 0) + 1);
    const memberProfileTrigger = rule.trigger_type === 6;
    if (
      (memberProfileTrigger && rule.event_type !== 2) ||
      (!memberProfileTrigger && rule.event_type !== 1)
    ) {
      throw new Error(`AutoMod rule ${rule.key} has an incompatible event and trigger type.`);
    }
    if (rule.exempt_role_keys.some((key) => !roles.has(key))) {
      throw new Error(`AutoMod rule ${rule.key} references an unknown exempt role.`);
    }
    if (rule.exempt_channel_keys.some((key) => !channels.has(key))) {
      throw new Error(`AutoMod rule ${rule.key} references an unknown exempt channel.`);
    }
    if (rule.trigger_type === 4 && rule.presets.length === 0) {
      throw new Error(`AutoMod rule ${rule.key} requires at least one keyword preset.`);
    }
    if (
      rule.trigger_type === 1 &&
      rule.keyword_filter.length === 0 &&
      rule.regex_patterns.length === 0
    ) {
      throw new Error(`AutoMod rule ${rule.key} requires a keyword or regex pattern.`);
    }
    if (rule.trigger_type !== 4 && rule.presets.length > 0) {
      throw new Error(`AutoMod rule ${rule.key} has keyword presets for the wrong trigger.`);
    }
    if (
      rule.trigger_type === 5 &&
      (rule.mention_total_limit === null || rule.mention_total_limit < 1)
    ) {
      throw new Error(`AutoMod rule ${rule.key} requires a positive mention limit.`);
    }
    if (rule.trigger_type !== 5 && rule.mention_total_limit !== null) {
      throw new Error(`AutoMod rule ${rule.key} has a mention limit for the wrong trigger.`);
    }
    for (const action of rule.actions) {
      if (action.alert_channel_key !== null && !channels.has(action.alert_channel_key)) {
        throw new Error(`AutoMod rule ${rule.key} references an unknown alert channel.`);
      }
      if (action.type === 2 && action.alert_channel_key === null) {
        throw new Error(`AutoMod rule ${rule.key} SEND_ALERT_MESSAGE requires an alert channel.`);
      }
      if (action.type !== 2 && action.alert_channel_key !== null) {
        throw new Error(`AutoMod rule ${rule.key} sets an alert channel on the wrong action.`);
      }
      if (action.type === 3 && rule.trigger_type !== 1 && rule.trigger_type !== 5) {
        throw new Error(`AutoMod rule ${rule.key} uses TIMEOUT with an incompatible trigger.`);
      }
      if (action.type === 3 && (action.duration_seconds === null || action.duration_seconds < 1)) {
        throw new Error(`AutoMod rule ${rule.key} TIMEOUT requires a positive duration.`);
      }
      if (action.type !== 3 && action.duration_seconds !== null) {
        throw new Error(`AutoMod rule ${rule.key} sets a duration on the wrong action.`);
      }
      if (action.type !== 1 && action.custom_message !== null) {
        throw new Error(`AutoMod rule ${rule.key} sets a custom message on the wrong action.`);
      }
    }
  }
  for (const [triggerType, count] of triggerCounts) {
    const limit = triggerType === 1 ? 6 : 1;
    if (count > limit) throw new Error(`AutoMod trigger ${triggerType} exceeds its guild cap.`);
  }
  for (const publication of blueprint.components_v2.publications) {
    if (!channels.has(publication.channel_key)) {
      throw new Error(`Publication ${publication.key} references an unknown channel.`);
    }
    const validation = validateComponentsV2(publication.components);
    if (!validation.valid) {
      throw new Error(`Publication ${publication.key} has invalid Components V2 content.`);
    }
    const serialized = JSON.stringify(publication.components);
    const placeholderStarts = serialized.match(/\{\{channel:/g)?.length ?? 0;
    const placeholders = [...serialized.matchAll(/\{\{channel:([^{}]+)\}\}/g)];
    if (placeholderStarts !== placeholders.length) {
      throw new Error(`Publication ${publication.key} has a malformed channel symbol.`);
    }
    for (const match of placeholders) {
      const key = match[1]!;
      if (!SymbolKey.safeParse(key).success || !channels.has(key)) {
        throw new Error(`Publication ${publication.key} has a dangling channel symbol.`);
      }
    }
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function blueprintFingerprint(blueprint: GuildBlueprint): string {
  return `sha256:${createHash('sha256').update(canonicalJson(blueprint)).digest('hex')}`;
}
