/**
 * Independent oracle for a bound guild blueprint readback.
 *
 * This deliberately contains only the literal blueprint-to-Discord mappings
 * needed by the benchmark. It must not share the reconciler's conclusions.
 */

const PERMISSION_BITS = Object.freeze({
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  SEND_MESSAGES: 1n << 11n,
  ADD_REACTIONS: 1n << 6n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  STREAM: 1n << 9n,
  USE_VAD: 1n << 25n,
  USE_EMBEDDED_ACTIVITIES: 1n << 39n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_THREADS: 1n << 34n,
  VIEW_AUDIT_LOG: 1n << 7n,
  KICK_MEMBERS: 1n << 1n,
  MODERATE_MEMBERS: 1n << 40n,
  CREATE_EVENTS: 1n << 41n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_GUILD: 1n << 5n,
  ADMINISTRATOR: 1n << 3n,
});

const BINDING_KINDS = Object.freeze([
  'roles',
  'categories',
  'channels',
  'automod_rules',
  'publications',
]);
const CHANNEL_TYPES = Object.freeze({ text: 0, voice: 2, stage: 13, forum: 15 });

function stable(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`;
}

function same(left, right) {
  return stable(left) === stable(right);
}

function issue(code, details = {}) {
  return { code, ...details };
}

function permissionBits(names = []) {
  return names.reduce((bits, name) => bits | PERMISSION_BITS[name], 0n).toString();
}

function sorted(values) {
  return [...values].sort();
}

function mapById(values) {
  return new Map((Array.isArray(values) ? values : []).map((value) => [String(value.id), value]));
}

function exactBindingKeys(blueprint, bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('bindings must be an object');
  }
  if (!same(sorted(Object.keys(bindings)), sorted(BINDING_KINDS))) {
    throw new TypeError('binding kinds do not exactly match blueprint bindings');
  }
  const expected = {
    roles: (blueprint.roles ?? []).map((item) => item.key),
    categories: (blueprint.categories ?? []).map((item) => item.key),
    channels: (blueprint.channels ?? []).map((item) => item.key),
    automod_rules: (blueprint.automod?.rules ?? []).map((item) => item.key),
    publications: (blueprint.components_v2?.publications ?? []).map((item) => item.key),
  };
  const used = new Set();
  for (const kind of BINDING_KINDS) {
    const actual = bindings[kind];
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      throw new TypeError(`binding ${kind} must be an object`);
    }
    if (new Set(expected[kind]).size !== expected[kind].length) {
      throw new TypeError(`duplicate blueprint binding key in ${kind}`);
    }
    const actualKeys = Object.keys(actual);
    if (!same(sorted(actualKeys), sorted(expected[kind]))) {
      throw new TypeError(`binding keyset for ${kind} does not exactly match blueprint`);
    }
    for (const key of expected[kind]) {
      const id = actual[key];
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError(`binding ${kind}.${key} must be a non-empty resource ID`);
      }
      if (used.has(id)) throw new TypeError(`duplicate binding resource ID ${id}`);
      used.add(id);
    }
  }
  return expected;
}

function overwriteShape(overwrite) {
  return {
    id: String(overwrite.id),
    type: Number(overwrite.type),
    allow: String(overwrite.allow ?? '0'),
    deny: String(overwrite.deny ?? '0'),
  };
}

function normalizedOverwrites(overwrites) {
  return (Array.isArray(overwrites) ? overwrites : [])
    .map(overwriteShape)
    .sort((left, right) => left.type - right.type || left.id.localeCompare(right.id));
}

function expectedOverwrites(items, guildId, botId, bindings) {
  return items.map((item) => {
    let id;
    let type;
    if (item.subject.kind === 'everyone') {
      id = guildId;
      type = 0;
    } else if (item.subject.kind === 'bot') {
      id = botId;
      type = 1;
    } else {
      id = bindings.roles[item.subject.key];
      type = 0;
    }
    return { id, type, allow: permissionBits(item.allow), deny: permissionBits(item.deny) };
  });
}

function roleFailures(blueprint, bindings, snapshot, failures) {
  const roles = mapById(snapshot.roles);
  for (const desired of blueprint.roles ?? []) {
    const id = bindings.roles[desired.key];
    const actual = roles.get(id);
    const expected = {
      name: desired.name,
      position: desired.position,
      permissions: permissionBits(desired.permissions),
      color: desired.color,
      hoist: desired.hoist,
      mentionable: desired.mentionable,
      managed: false,
    };
    if (
      actual === undefined ||
      actual.name !== expected.name ||
      Number(actual.position ?? 0) !== expected.position ||
      String(actual.permissions ?? '0') !== expected.permissions ||
      Number(actual.color ?? 0) !== expected.color ||
      Boolean(actual.hoist) !== expected.hoist ||
      Boolean(actual.mentionable) !== expected.mentionable ||
      actual.managed
    ) {
      failures.push(issue('ROLE_MISMATCH', { key: desired.key, resource_id: id }));
    }
  }
}

function categoryFailures(blueprint, bindings, snapshot, guildId, botId, failures) {
  const channels = mapById(snapshot.channels);
  for (const desired of blueprint.categories ?? []) {
    const id = bindings.categories[desired.key];
    const actual = channels.get(id);
    const expected = expectedOverwrites(desired.overwrites ?? [], guildId, botId, bindings);
    if (
      actual === undefined ||
      actual.guild_id !== guildId ||
      Number(actual.type) !== 4 ||
      actual.name !== desired.name ||
      Number(actual.position ?? 0) !== desired.position ||
      (actual.parent_id ?? null) !== null ||
      !same(normalizedOverwrites(actual.permission_overwrites), normalizedOverwrites(expected))
    ) {
      failures.push(issue('CATEGORY_MISMATCH', { key: desired.key, resource_id: id }));
    }
  }
}

function channelTags(value) {
  return (Array.isArray(value) ? value : []).map((tag) => ({
    name: tag.name,
    moderated: Boolean(tag.moderated),
    emoji_id: tag.emoji_id ?? null,
    emoji_name: tag.emoji_name ?? null,
  }));
}

function channelFailures(blueprint, bindings, snapshot, guildId, botId, failures) {
  const channels = mapById(snapshot.channels);
  const categories = new Map((blueprint.categories ?? []).map((item) => [item.key, item]));
  for (const desired of blueprint.channels ?? []) {
    const id = bindings.channels[desired.key];
    const actual = channels.get(id);
    const parentId = bindings.categories[desired.parent_key];
    const expectedOverwrites = expectedOverwritesForChannel(desired, bindings, guildId, botId);
    const actualOverwrites = normalizedOverwrites(actual?.permission_overwrites);
    const overwriteMatches = same(actualOverwrites, normalizedOverwrites(expectedOverwrites));
    const inherited =
      (desired.overwrites ?? []).length === 0 && categories.get(desired.parent_key) !== undefined
        ? normalizedOverwrites(
            expectedOverwritesForChannel(
              categories.get(desired.parent_key),
              bindings,
              guildId,
              botId,
            ),
          )
        : null;
    const permissionsMatch =
      overwriteMatches ||
      (inherited !== null && (actualOverwrites.length === 0 || same(actualOverwrites, inherited)));
    const expectedTopic =
      desired.topic !== null && (desired.type === 'text' || desired.type === 'forum')
        ? desired.topic
        : null;
    const expectedTags = desired.type === 'forum' ? channelTags(desired.forum_tags) : [];
    if (
      actual === undefined ||
      actual.guild_id !== guildId ||
      Number(actual.type) !== CHANNEL_TYPES[desired.type] ||
      actual.name !== desired.name ||
      Number(actual.position ?? 0) !== desired.position ||
      (actual.parent_id ?? null) !== parentId ||
      (actual.topic ?? null) !== expectedTopic ||
      actual.nsfw ||
      Number(actual.rate_limit_per_user ?? 0) !== desired.slowmode_seconds ||
      !permissionsMatch ||
      (desired.type === 'forum' && !same(channelTags(actual.available_tags), expectedTags))
    ) {
      failures.push(issue('CHANNEL_MISMATCH', { key: desired.key, resource_id: id }));
    }
  }
}

function expectedOverwritesForChannel(item, bindings, guildId, botId) {
  if (item === undefined) return [];
  return expectedOverwrites(item.overwrites ?? [], guildId, botId, bindings);
}

function guildFailures(blueprint, bindings, snapshot, guildId, failures) {
  const guild = snapshot.guild ?? {};
  const community = blueprint.guild?.community ?? {};
  const expected = {
    id: guildId,
    name: blueprint.guild?.name,
    description: blueprint.guild?.description,
    preferred_locale: blueprint.guild?.preferred_locale,
    verification_level: blueprint.guild?.verification_level,
    default_message_notifications: blueprint.guild?.default_message_notifications,
    explicit_content_filter: blueprint.guild?.explicit_content_filter,
    rules_channel_id: bindings.channels[community.rules_channel_key],
    public_updates_channel_id: bindings.channels[community.public_updates_channel_key],
    safety_alerts_channel_id: bindings.channels[community.safety_alerts_channel_key],
  };
  const actual = {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    preferred_locale: guild.preferred_locale,
    verification_level: guild.verification_level,
    default_message_notifications: guild.default_message_notifications,
    explicit_content_filter: guild.explicit_content_filter,
    rules_channel_id: guild.rules_channel_id,
    public_updates_channel_id: guild.public_updates_channel_id,
    safety_alerts_channel_id: guild.safety_alerts_channel_id,
  };
  if (!same(actual, expected) || !(guild.features ?? []).includes('COMMUNITY')) {
    failures.push(issue('GUILD_MISMATCH', { resource_id: guildId }));
  }
}

function welcomeFailures(blueprint, bindings, snapshot, failures) {
  const desired = blueprint.guild?.welcome_screen;
  const actual = snapshot.welcome_screen;
  const channels = new Map((blueprint.channels ?? []).map((item) => [item.key, item]));
  const expectedChannels = (desired?.channel_keys ?? []).map((key) => ({
    channel_id: bindings.channels[key],
    description: (channels.get(key)?.topic ?? `Visit #${channels.get(key)?.name ?? ''}`).slice(
      0,
      50,
    ),
    emoji_id: null,
    emoji_name: '👋',
  }));
  const actualShape =
    actual === null || actual === undefined
      ? null
      : {
          description: actual.description,
          welcome_channels: (actual.welcome_channels ?? []).map((channel) => ({
            channel_id: channel.channel_id,
            description: channel.description,
            emoji_id: channel.emoji_id ?? null,
            emoji_name: channel.emoji_name ?? null,
          })),
        };
  if (
    actualShape === null ||
    !same(actualShape, { description: desired?.description, welcome_channels: expectedChannels })
  ) {
    failures.push(issue('WELCOME_SCREEN_MISMATCH'));
  }
}

function normalizedOnboardingPrompt(prompt) {
  return {
    type: prompt.type,
    title: prompt.title,
    single_select: prompt.single_select,
    required: prompt.required,
    in_onboarding: prompt.in_onboarding,
    options: (Array.isArray(prompt.options) ? prompt.options : []).map((option) => ({
      title: option.title,
      description: option.description ?? '',
      role_ids: sorted(Array.isArray(option.role_ids) ? option.role_ids : []),
      channel_ids: sorted(Array.isArray(option.channel_ids) ? option.channel_ids : []),
      emoji_id: option.emoji_id ?? null,
      emoji_name: option.emoji_name ?? null,
      emoji_animated: option.emoji_animated ?? false,
    })),
  };
}

function onboardingFailures(blueprint, bindings, snapshot, failures) {
  const desired = blueprint.onboarding ?? {};
  const actual = snapshot.onboarding;
  const expectedPrompts = (desired.prompts ?? []).map((prompt) => ({
    type: prompt.type,
    title: prompt.title,
    single_select: prompt.single_select,
    required: prompt.required,
    in_onboarding: prompt.in_onboarding,
    options: (prompt.options ?? []).map((option) => ({
      title: option.title,
      description: option.description,
      role_ids: option.role_keys.map((key) => bindings.roles[key]),
      channel_ids: option.channel_keys.map((key) => bindings.channels[key]),
      emoji_id: null,
      emoji_name: null,
      emoji_animated: false,
    })),
  }));
  const expected = {
    enabled: desired.enabled,
    mode: desired.mode,
    default_channel_ids: sorted(
      (desired.default_channel_keys ?? []).map((key) => bindings.channels[key]),
    ),
    prompts: expectedPrompts,
  };
  const actualShape =
    actual === null || actual === undefined
      ? null
      : {
          enabled: actual.enabled,
          mode: actual.mode,
          default_channel_ids: sorted(actual.default_channel_ids ?? []),
          prompts: (actual.prompts ?? []).map(normalizedOnboardingPrompt),
        };
  if (
    actualShape === null ||
    !same(actualShape, { ...expected, prompts: expected.prompts.map(normalizedOnboardingPrompt) })
  ) {
    failures.push(issue('ONBOARDING_MISMATCH'));
  }
}

function automodMetadata(rule) {
  switch (rule.trigger_type) {
    case 1:
    case 6:
      return {
        keyword_filter: rule.keyword_filter,
        regex_patterns: rule.regex_patterns,
        allow_list: rule.allow_list,
      };
    case 4:
      return { presets: rule.presets, allow_list: rule.allow_list };
    case 5:
      return {
        mention_total_limit: rule.mention_total_limit,
        mention_raid_protection_enabled: rule.mention_raid_protection_enabled,
      };
    default:
      return {};
  }
}

function normalizedAutomod(value) {
  return {
    name: value.name,
    event_type: value.event_type,
    trigger_type: value.trigger_type,
    trigger_metadata: value.trigger_metadata ?? {},
    actions: value.actions ?? [],
    enabled: value.enabled,
    exempt_roles: sorted(value.exempt_roles ?? []),
    exempt_channels: sorted(value.exempt_channels ?? []),
  };
}

function automodFailures(blueprint, bindings, snapshot, failures) {
  const rules = mapById(snapshot.automod_rules);
  for (const desired of blueprint.automod?.rules ?? []) {
    const id = bindings.automod_rules[desired.key];
    const actions = (desired.actions ?? []).map((action) => {
      const metadata = {};
      if (action.alert_channel_key !== null)
        metadata.channel_id = bindings.channels[action.alert_channel_key];
      if (action.duration_seconds !== null) metadata.duration_seconds = action.duration_seconds;
      if (action.custom_message !== null) metadata.custom_message = action.custom_message;
      return { type: action.type, ...(Object.keys(metadata).length ? { metadata } : {}) };
    });
    const expected = {
      name: desired.name,
      event_type: desired.event_type,
      trigger_type: desired.trigger_type,
      trigger_metadata: automodMetadata(desired),
      actions,
      enabled: desired.enabled,
      exempt_roles: (desired.exempt_role_keys ?? []).map((key) => bindings.roles[key]),
      exempt_channels: (desired.exempt_channel_keys ?? []).map((key) => bindings.channels[key]),
    };
    const actual = rules.get(id);
    if (actual === undefined || !same(normalizedAutomod(actual), normalizedAutomod(expected))) {
      failures.push(issue('AUTOMOD_RULE_MISMATCH', { key: desired.key, resource_id: id }));
    }
  }
}

function resolveChannels(value, bindings) {
  if (typeof value === 'string') {
    return value.replace(/\{\{channel:([a-z][a-z0-9_]{0,63})\}\}/g, (match, key) => {
      const id = bindings.channels[key];
      return id === undefined ? match : id;
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveChannels(item, bindings));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveChannels(child, bindings)]),
    );
  }
  return value;
}

function normalizeComponents(value, marker, stripMarker = true) {
  if (Array.isArray(value))
    return value.map((item) => normalizeComponents(item, marker, stripMarker));
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'id')
      .map(([key, child]) => [key, normalizeComponents(child, marker, stripMarker)]),
  );
  if (
    stripMarker &&
    normalized.type === 10 &&
    typeof normalized.content === 'string' &&
    normalized.content.endsWith(`\n\n${marker}`)
  ) {
    normalized.content = normalized.content.slice(0, -`\n\n${marker}`.length);
  }
  return normalized;
}

function publicationFailures(blueprint, blueprintId, bindings, snapshot, botId, failures) {
  const messages = new Map();
  for (const items of Object.values(snapshot.recent_messages ?? {})) {
    for (const message of Array.isArray(items) ? items : [])
      messages.set(String(message.id), message);
  }
  for (const publication of blueprint.components_v2?.publications ?? []) {
    const channelId = bindings.channels[publication.channel_key];
    const marker = `-# Managed by discord-mcp · blueprint ${blueprintId.slice(7, 19)} · publication ${publication.key}`;
    const message = messages.get(bindings.publications[publication.key]);
    if (snapshot.publication_history_complete?.[channelId] !== true) {
      failures.push(
        issue('PUBLICATION_HISTORY_INCOMPLETE', { key: publication.key, channel_id: channelId }),
      );
    }
    if (message === undefined) {
      failures.push(
        issue('PUBLICATION_MISSING', {
          key: publication.key,
          resource_id: bindings.publications[publication.key],
        }),
      );
      continue;
    }
    if (String(message.channel_id) !== String(channelId)) {
      failures.push(issue('PUBLICATION_CHANNEL_MISMATCH', { key: publication.key }));
    }
    if (message.author?.id !== botId)
      failures.push(issue('PUBLICATION_AUTHOR_MISMATCH', { key: publication.key }));
    if (typeof message.flags !== 'number' || (message.flags & 32768) !== 32768) {
      failures.push(issue('PUBLICATION_FLAGS_MISMATCH', { key: publication.key }));
    }
    if (
      message.mention_everyone === true ||
      (message.mentions?.length ?? 0) !== 0 ||
      (message.mention_roles?.length ?? 0) !== 0
    ) {
      failures.push(issue('PUBLICATION_MENTIONS_MISMATCH', { key: publication.key }));
    }
    if (
      message.nonce !== undefined &&
      (typeof message.nonce !== 'string' || !message.nonce.startsWith('dmc'))
    ) {
      failures.push(issue('PUBLICATION_NONCE_MISMATCH', { key: publication.key }));
    }
    const expected = resolveChannels(publication.components, bindings);
    if (
      !same(
        normalizeComponents(message.components ?? [], marker),
        normalizeComponents(expected, marker, false),
      )
    ) {
      failures.push(issue('PUBLICATION_COMPONENTS_MISMATCH', { key: publication.key }));
    }
  }
}

export function verifyBlueprintSnapshot({
  blueprint,
  blueprintId,
  bindings,
  snapshot,
  guildId,
  botId,
}) {
  if (blueprint === null || typeof blueprint !== 'object')
    throw new TypeError('blueprint must be an object');
  if (typeof blueprintId !== 'string' || blueprintId.length < 19)
    throw new TypeError('blueprintId must be supplied');
  const expectedKeys = exactBindingKeys(blueprint, bindings);
  const failures = [];
  const safeSnapshot = snapshot ?? {};
  roleFailures(blueprint, bindings, safeSnapshot, failures);
  categoryFailures(blueprint, bindings, safeSnapshot, guildId, botId, failures);
  channelFailures(blueprint, bindings, safeSnapshot, guildId, botId, failures);
  guildFailures(blueprint, bindings, safeSnapshot, guildId, failures);
  welcomeFailures(blueprint, bindings, safeSnapshot, failures);
  onboardingFailures(blueprint, bindings, safeSnapshot, failures);
  automodFailures(blueprint, bindings, safeSnapshot, failures);
  if (safeSnapshot.bot?.user?.id !== botId) {
    failures.push(issue('BOT_MISMATCH', { expected: botId, actual: safeSnapshot.bot.user.id }));
  }
  publicationFailures(blueprint, blueprintId, bindings, safeSnapshot, botId, failures);
  return {
    match: failures.length === 0,
    failures,
    verified_counts: {
      roles: expectedKeys.roles.length,
      categories: expectedKeys.categories.length,
      channels: expectedKeys.channels.length,
      automod_rules: expectedKeys.automod_rules.length,
      publications: expectedKeys.publications.length,
      onboarding_prompts: (blueprint.onboarding?.prompts ?? []).length,
    },
  };
}
