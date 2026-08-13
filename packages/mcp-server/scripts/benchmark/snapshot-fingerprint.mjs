import { createHash } from 'node:crypto';

// These fields are supplied by Discord but can change without a security or
// configuration change. Keep this list deliberately narrow: every other raw
// field is retained in the baseline fingerprint so an omitted field cannot
// hide drift.
const VOLATILE_KEYS = new Set([
  'approximate_member_count',
  'approximate_presence_count',
  'archive_timestamp',
  'communication_disabled_until',
  'edited_timestamp',
  'joined_at',
  'last_message_id',
  'last_pin_timestamp',
  'member_count',
  'message_count',
  'premium_since',
  'session_id',
  'session_start_timestamp',
  'timestamp',
]);

// Discord adds this historical capability marker after onboarding is enabled
// once and does not remove it when onboarding is disabled again. It is not a
// mutable configuration or permission boundary, so it cannot participate in
// exact baseline restoration.
const NON_RESTORABLE_GUILD_FEATURES = new Set(['GUILD_ONBOARDING_EVER_ENABLED']);

function sanitizeRaw(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sanitizeRaw(item)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => item !== undefined && !VOLATILE_KEYS.has(key))
        .map(([key, item]) => [key, sanitizeRaw(item)]),
    );
  }
  return value;
}

function sortById(values) {
  return [...values].sort((left, right) => {
    const leftId = left !== null && typeof left === 'object' ? left.id : left;
    const rightId = right !== null && typeof right === 'object' ? right.id : right;
    return String(leftId).localeCompare(String(rightId));
  });
}

function sortOverwrites(values) {
  return [...values].sort((left, right) => {
    const type = Number(left?.type ?? 0) - Number(right?.type ?? 0);
    if (type !== 0) return type;
    return String(left?.id).localeCompare(String(right?.id));
  });
}

function roleView(role) {
  return sanitizeRaw(role);
}

function channelView(channel) {
  const view = sanitizeRaw(channel);
  if (Array.isArray(view.permission_overwrites)) {
    view.permission_overwrites = sortOverwrites(view.permission_overwrites);
  }
  if (Array.isArray(view.available_tags)) {
    view.available_tags = sortById(view.available_tags);
  }
  if (Array.isArray(view.default_tag_ids)) {
    view.default_tag_ids = sortById(view.default_tag_ids);
  }
  return view;
}

function messageView(message) {
  return sanitizeRaw(message);
}

function onboardingView(onboarding) {
  const view = sanitizeRaw(onboarding);
  if (view !== null && typeof view === 'object' && !Array.isArray(view)) {
    // Discord computes this response-only flag; it is not accepted by the
    // Modify Guild Onboarding endpoint and can change after convergence.
    delete view.below_requirements;
  }
  return view;
}

export function snapshotSecurityView(snapshot) {
  const messages = Object.fromEntries(
    Object.entries(snapshot.recent_messages ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([channelId, items]) => [channelId, sortById(items).map(messageView)]),
  );
  const bot = sanitizeRaw(snapshot.bot ?? {});
  if (Array.isArray(bot.roles)) bot.roles = [...bot.roles].sort();
  const guild = sanitizeRaw(snapshot.guild ?? {});
  if (Array.isArray(guild.features)) {
    guild.features = guild.features
      .filter((feature) => !NON_RESTORABLE_GUILD_FEATURES.has(feature))
      .sort();
  }
  return {
    guild,
    bot,
    roles: sortById(snapshot.roles ?? []).map(roleView),
    channels: sortById(snapshot.channels ?? []).map(channelView),
    automod_rules: sortById(snapshot.automod_rules ?? []).map(sanitizeRaw),
    onboarding: onboardingView(snapshot.onboarding ?? null),
    welcome_screen: sanitizeRaw(snapshot.welcome_screen ?? null),
    recent_messages: messages,
    publication_history_complete: Object.fromEntries(
      Object.entries(snapshot.publication_history_complete ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function snapshotFingerprint(snapshot) {
  const digest = createHash('sha256')
    .update(canonicalJson(snapshotSecurityView(snapshot)))
    .digest('hex');
  return `sha256:${digest}`;
}
