import { type RawGuildTemplate, templateBlueprint } from './template.js';

export const TEMPLATE_CAPABILITIES = ['lfg', 'staff', 'platform', 'events', 'support'] as const;

export type TemplateCapability = (typeof TEMPLATE_CAPABILITIES)[number];

export interface TemplateCapabilityEvidence {
  readonly channel_name_matches: number;
  readonly category_name_matches: number;
  readonly role_name_matches: number;
  readonly metadata_matches: number;
  readonly matched: boolean;
}

export interface TemplateQualitySignals {
  readonly has_categories: boolean;
  readonly has_text_and_voice: boolean;
  readonly has_non_default_roles: boolean;
  readonly has_permission_overwrites: boolean;
  readonly has_forum_channels: boolean;
  readonly has_stage_channels: boolean;
  readonly nsfw_channel_count: number;
  readonly privileged_role_count: number;
  readonly risky_permission_class_count: number;
  readonly marked_dirty: boolean | null;
}

export interface TemplateRecommendationEvidence {
  readonly blueprint: ReturnType<typeof templateBlueprint>;
  readonly capabilities: Readonly<Record<TemplateCapability, TemplateCapabilityEvidence>>;
  readonly quality_signals: TemplateQualitySignals;
}

type SourceRecord = Record<string, unknown>;

type Phrase = readonly string[];

interface CapabilityMatcher {
  readonly singleTokens: ReadonlySet<string>;
  readonly phrases: readonly Phrase[];
}

const MATCHERS: Readonly<Record<TemplateCapability, CapabilityMatcher>> = {
  lfg: {
    singleTokens: new Set([
      'lfg',
      'recruit',
      'recruitment',
      'matchmaking',
      'squad',
      'party',
      'clan',
      'guild',
      'teammate',
      'teammates',
    ]),
    phrases: [
      ['looking', 'for', 'group'],
      ['looking', 'for', 'team'],
      ['looking', 'for', 'teammates'],
      ['find', 'team'],
      ['find', 'teammates'],
      ['team', 'up'],
      ['tim', 'dong', 'doi'],
    ],
  },
  staff: {
    singleTokens: new Set([
      'staff',
      'mod',
      'mods',
      'moderator',
      'moderators',
      'moderation',
      'admin',
      'admins',
      'administrator',
      'administrators',
      'management',
    ]),
    phrases: [
      ['quan', 'tri'],
      ['doi', 'ngu', 'quan', 'tri'],
    ],
  },
  platform: {
    singleTokens: new Set([
      'pc',
      'xbox',
      'playstation',
      'ps4',
      'ps5',
      'switch',
      'mobile',
      'android',
      'ios',
      'console',
      'platform',
      'crossplay',
      'steam',
      'epic',
      'mac',
      'linux',
    ]),
    phrases: [],
  },
  events: {
    singleTokens: new Set([
      'event',
      'events',
      'tournament',
      'tournaments',
      'giveaway',
      'giveaways',
      'contest',
      'contests',
      'schedule',
      'scrim',
      'scrims',
    ]),
    phrases: [
      ['su', 'kien'],
      ['giai', 'dau'],
    ],
  },
  support: {
    singleTokens: new Set([
      'support',
      'help',
      'ticket',
      'tickets',
      'faq',
      'bug',
      'bugs',
      'report',
      'reports',
      'contact',
    ]),
    phrases: [
      ['tro', 'giup'],
      ['ho', 'tro'],
    ],
  },
};

function records(value: unknown): SourceRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is SourceRecord => typeof item === 'object' && item !== null)
    : [];
}

function sourceGuild(template: RawGuildTemplate): SourceRecord {
  const source = template.serialized_source_guild;
  return source === undefined ? {} : source;
}

function sourceChannels(template: RawGuildTemplate): SourceRecord[] {
  return records(sourceGuild(template).channels);
}

function sourceRoles(template: RawGuildTemplate): SourceRecord[] {
  return records(sourceGuild(template).roles);
}

/**
 * Fold names for matching only. The original third-party text never leaves
 * the input boundary, and removing combining marks makes Vietnamese phrases
 * match both accented and unaccented spellings.
 */
function normalizedTokens(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  return (
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      // The Vietnamese đ/Đ letters do not decompose under Unicode NFKD.
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/gu)
      .filter(Boolean)
      .slice(0, 128)
  );
}

function containsPhrase(tokens: readonly string[], phrase: Phrase): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
    let matches = true;
    for (let index = 0; index < phrase.length; index += 1) {
      if (tokens[start + index] !== phrase[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function matchesCapability(value: unknown, matcher: CapabilityMatcher): boolean {
  const tokens = normalizedTokens(value);
  if (tokens.some((token) => matcher.singleTokens.has(token))) return true;
  return matcher.phrases.some((phrase) => containsPhrase(tokens, phrase));
}

function capabilityCounts(
  template: RawGuildTemplate,
  capability: TemplateCapability,
): TemplateCapabilityEvidence {
  const matcher = MATCHERS[capability];
  const channels = sourceChannels(template);
  const roles = sourceRoles(template);
  let channelNameMatches = 0;
  let categoryNameMatches = 0;
  let roleNameMatches = 0;

  for (const channel of channels) {
    if (!matchesCapability(channel.name, matcher)) continue;
    if (channel.type === 4) categoryNameMatches += 1;
    else channelNameMatches += 1;
  }

  for (const role of roles) {
    if (matchesCapability(role.name, matcher)) roleNameMatches += 1;
  }

  let metadataMatches = 0;
  if (matchesCapability(template.name, matcher)) metadataMatches += 1;

  return {
    channel_name_matches: channelNameMatches,
    category_name_matches: categoryNameMatches,
    role_name_matches: roleNameMatches,
    metadata_matches: metadataMatches,
    matched: channelNameMatches + categoryNameMatches + roleNameMatches + metadataMatches > 0,
  };
}

/**
 * Compile a live Guild Template into bounded, sanitized recommendation
 * evidence. Only deterministic counts and booleans are returned; names,
 * descriptions, topics and permission-overwrite payloads remain untrusted
 * and are intentionally not included here.
 */
export function templateRecommendationEvidence(
  template: RawGuildTemplate,
): TemplateRecommendationEvidence {
  const blueprint = templateBlueprint(template);
  const capabilities = Object.fromEntries(
    TEMPLATE_CAPABILITIES.map((capability) => [capability, capabilityCounts(template, capability)]),
  ) as Record<TemplateCapability, TemplateCapabilityEvidence>;

  return {
    blueprint,
    capabilities,
    quality_signals: {
      has_categories: blueprint.category_count > 0,
      has_text_and_voice: blueprint.text_channel_count > 0 && blueprint.voice_channel_count > 0,
      has_non_default_roles: blueprint.role_count > 1,
      has_permission_overwrites: blueprint.permission_overwrite_count > 0,
      has_forum_channels: blueprint.forum_channel_count > 0,
      has_stage_channels: blueprint.stage_channel_count > 0,
      nsfw_channel_count: blueprint.nsfw_channel_count,
      privileged_role_count: blueprint.privileged_role_count,
      risky_permission_class_count: blueprint.risky_permission_signals.length,
      marked_dirty: template.is_dirty ?? null,
    },
  };
}
