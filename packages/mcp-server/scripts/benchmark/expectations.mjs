/**
 * Build benchmark expectations from the literal blueprint and the create
 * bindings.  This module intentionally has no dependency on production
 * blueprint, reconcile, or evidence code.
 */

const SNOWFLAKE = /^\d{17,20}$/;
const BINDING_KINDS = Object.freeze([
  'roles',
  'categories',
  'channels',
  'automod_rules',
  'publications',
]);
const SINGLETON_AUTOMOD_TRIGGER_TYPES = Object.freeze(new Set([3, 4, 5]));
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
  CREATE_EVENTS: 1n << 44n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_GUILD: 1n << 5n,
  ADMINISTRATOR: 1n << 3n,
});

function fail(message) {
  throw new TypeError(`Invalid benchmark expectations input: ${message}`);
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return value;
}

function array(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function snowflake(value, path) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value))
    fail(`${path} must be a Discord snowflake`);
  return value;
}

function own(object, key, path) {
  if (!Object.hasOwn(object, key)) fail(`unknown ${path} reference ${key}`);
  return object[key];
}

function permissionBits(names, path) {
  if (!Array.isArray(names)) fail(`${path} must be an array`);
  let bits = 0n;
  for (const [index, name] of names.entries()) {
    if (typeof name !== 'string' || !Object.hasOwn(PERMISSION_BITS, name)) {
      fail(`${path}[${index}] has unknown permission ${String(name)}`);
    }
    bits |= PERMISSION_BITS[name];
  }
  return bits.toString();
}

function expectedKeys(blueprint) {
  const keys = {
    roles: array(blueprint.roles, 'blueprint.roles').map((item, index) => {
      record(item, `blueprint.roles[${index}]`);
      if (typeof item.key !== 'string') fail(`blueprint.roles[${index}].key must be a string`);
      return item.key;
    }),
    categories: array(blueprint.categories, 'blueprint.categories').map((item, index) => {
      record(item, `blueprint.categories[${index}]`);
      if (typeof item.key !== 'string') fail(`blueprint.categories[${index}].key must be a string`);
      return item.key;
    }),
    channels: array(blueprint.channels, 'blueprint.channels').map((item, index) => {
      record(item, `blueprint.channels[${index}]`);
      if (typeof item.key !== 'string') fail(`blueprint.channels[${index}].key must be a string`);
      return item.key;
    }),
    automod_rules: array(blueprint.automod?.rules, 'blueprint.automod.rules').map((item, index) => {
      record(item, `blueprint.automod.rules[${index}]`);
      if (typeof item.key !== 'string')
        fail(`blueprint.automod.rules[${index}].key must be a string`);
      return item.key;
    }),
    publications: array(
      blueprint.components_v2?.publications,
      'blueprint.components_v2.publications',
    ).map((item, index) => {
      record(item, `blueprint.components_v2.publications[${index}]`);
      if (typeof item.key !== 'string')
        fail(`blueprint.components_v2.publications[${index}].key must be a string`);
      return item.key;
    }),
  };
  for (const [kind, values] of Object.entries(keys)) {
    if (new Set(values).size !== values.length) fail(`duplicate blueprint binding key in ${kind}`);
  }
  if (
    new Set([...keys.categories, ...keys.channels]).size !==
    keys.categories.length + keys.channels.length
  ) {
    fail(
      'category and channel binding keys must be distinct when categories are folded into channels',
    );
  }
  return keys;
}

function exactBindings(bindings, keys) {
  record(bindings, 'bindings');
  if (JSON.stringify(Object.keys(bindings).sort()) !== JSON.stringify([...BINDING_KINDS].sort())) {
    fail('binding kinds do not exactly match blueprint bindings');
  }
  const allIds = new Set();
  const result = {};
  for (const kind of BINDING_KINDS) {
    const value = record(bindings[kind], `bindings.${kind}`);
    const actual = Object.keys(value).sort();
    const expected = [...keys[kind]].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail(`binding keyset for ${kind} does not exactly match blueprint`);
    result[kind] = {};
    for (const key of keys[kind]) {
      const id = snowflake(value[key], `bindings.${kind}.${key}`);
      if (allIds.has(id)) fail(`duplicate binding resource ID ${id}`);
      allIds.add(id);
      result[kind][key] = id;
    }
  }
  return { result, allIds };
}

function beforeResourceIds(before) {
  const ids = new Set();
  const add = (value, path) => {
    const id = snowflake(value?.id, `${path}.id`);
    if (ids.has(id)) fail(`duplicate preexisting resource ID ${id}`);
    ids.add(id);
    return id;
  };
  for (const [index, item] of array(before.roles, 'before.roles').entries())
    add(item, `before.roles[${index}]`);
  for (const [index, item] of array(before.channels, 'before.channels').entries())
    add(item, `before.channels[${index}]`);
  for (const [index, item] of array(before.automod_rules, 'before.automod_rules').entries())
    add(item, `before.automod_rules[${index}]`);
  for (const [channelId, messages] of Object.entries(before.recent_messages ?? {})) {
    snowflake(channelId, `before.recent_messages.${channelId}`);
    for (const [index, item] of array(messages, `before.recent_messages.${channelId}`).entries())
      add(item, `before.recent_messages.${channelId}[${index}]`);
  }
  return ids;
}

function validateBefore(before, guildId, botId) {
  record(before, 'before');
  if (before.guild?.id !== guildId) fail('before guild identity does not match guildId');
  if (before.bot?.user?.id !== botId) fail('before bot identity does not match botId');
  const botRoles = array(before.bot?.roles, 'before.bot.roles');
  const botRoleIds = new Set(
    botRoles.map((id, index) => snowflake(id, `before.bot.roles[${index}]`)),
  );
  if (botRoleIds.size !== botRoles.length) fail('before.bot.roles contains duplicate IDs');
  if (botRoleIds.has(guildId)) fail('bot role list must not contain the @everyone role');
  return { ids: new Set([...beforeResourceIds(before), ...botRoleIds]), botRoleIds };
}

function adoptedAutomodIds(blueprint, bindings, before, botId) {
  const rules = array(before.automod_rules, 'before.automod_rules');
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const adopted = [];
  const triggerTypes = {};
  for (const desired of array(blueprint.automod?.rules, 'blueprint.automod.rules')) {
    const id = bindings.automod_rules[desired.key];
    const existing = byId.get(id);
    if (existing === undefined || !SINGLETON_AUTOMOD_TRIGGER_TYPES.has(desired.trigger_type))
      continue;
    if (existing.creator_id === botId && existing.trigger_type === desired.trigger_type) {
      const sameTriggerRules = rules.filter((rule) => rule.trigger_type === desired.trigger_type);
      if (sameTriggerRules.length !== 1)
        fail(
          `blueprint.automod.rules for singleton trigger type ${String(desired.trigger_type)} must have exactly one preexisting rule`,
        );
      adopted.push(id);
      triggerTypes[id] = desired.trigger_type;
    }
  }
  return { ids: adopted, triggerTypes };
}

function subjectReference(subject, bindings, path, guildId, botId) {
  record(subject, path);
  if (subject.kind === 'everyone') return { id: guildId, type: 0 };
  if (subject.kind === 'bot') return { id: botId, type: 1 };
  if (subject.kind === 'role') {
    if (typeof subject.key !== 'string') fail(`${path}.key must be a role binding key`);
    return { id: own(bindings.roles, subject.key, `${path}.role`), type: 0 };
  }
  fail(`${path}.kind is unknown`);
}

function collectReferences(blueprint, bindings, guildId, botId) {
  const categories = new Set(Object.keys(bindings.categories));
  const channels = new Set(Object.keys(bindings.channels));
  const roles = new Set(Object.keys(bindings.roles));
  const requireKey = (set, key, path) => {
    if (typeof key !== 'string' || !set.has(key)) fail(`unknown ${path} reference ${String(key)}`);
  };
  for (const [index, key] of array(blueprint.role_order, 'blueprint.role_order').entries())
    requireKey(roles, key, `blueprint.role_order[${index}]`);
  permissionBits(
    blueprint.bot_boundary?.always_required_permissions ?? [],
    'blueprint.bot_boundary.always_required_permissions',
  );
  for (const [index, requirement] of array(
    blueprint.bot_boundary?.conditional_requirements,
    'blueprint.bot_boundary.conditional_requirements',
  ).entries())
    permissionBits(
      [requirement.permission],
      `blueprint.bot_boundary.conditional_requirements[${index}].permission`,
    );
  for (const [index, item] of array(blueprint.categories, 'blueprint.categories').entries()) {
    for (const [overwriteIndex, overwrite] of array(
      item.overwrites,
      `blueprint.categories[${index}].overwrites`,
    ).entries()) {
      subjectReference(
        overwrite.subject,
        bindings,
        `blueprint.categories[${index}].overwrites[${overwriteIndex}].subject`,
        guildId,
        botId,
      );
      permissionBits(
        overwrite.allow,
        `blueprint.categories[${index}].overwrites[${overwriteIndex}].allow`,
      );
      permissionBits(
        overwrite.deny,
        `blueprint.categories[${index}].overwrites[${overwriteIndex}].deny`,
      );
    }
  }
  for (const [index, item] of array(blueprint.channels, 'blueprint.channels').entries()) {
    requireKey(categories, item.parent_key, `blueprint.channels[${index}].parent_key`);
    for (const [overwriteIndex, overwrite] of array(
      item.overwrites,
      `blueprint.channels[${index}].overwrites`,
    ).entries()) {
      subjectReference(
        overwrite.subject,
        bindings,
        `blueprint.channels[${index}].overwrites[${overwriteIndex}].subject`,
        guildId,
        botId,
      );
      permissionBits(
        overwrite.allow,
        `blueprint.channels[${index}].overwrites[${overwriteIndex}].allow`,
      );
      permissionBits(
        overwrite.deny,
        `blueprint.channels[${index}].overwrites[${overwriteIndex}].deny`,
      );
    }
  }
  const community = blueprint.guild?.community ?? {};
  for (const name of [
    'rules_channel_key',
    'public_updates_channel_key',
    'safety_alerts_channel_key',
  ])
    requireKey(channels, community[name], `blueprint.guild.community.${name}`);
  for (const [index, key] of array(
    blueprint.guild?.welcome_screen?.channel_keys,
    'blueprint.guild.welcome_screen.channel_keys',
  ).entries())
    requireKey(channels, key, `blueprint.guild.welcome_screen.channel_keys[${index}]`);
  for (const [index, key] of array(
    blueprint.onboarding?.default_channel_keys,
    'blueprint.onboarding.default_channel_keys',
  ).entries())
    requireKey(channels, key, `blueprint.onboarding.default_channel_keys[${index}]`);
  for (const [promptIndex, prompt] of array(
    blueprint.onboarding?.prompts,
    'blueprint.onboarding.prompts',
  ).entries()) {
    for (const [optionIndex, option] of array(
      prompt.options,
      `blueprint.onboarding.prompts[${promptIndex}].options`,
    ).entries()) {
      for (const [index, key] of array(
        option.role_keys,
        `blueprint.onboarding.prompts[${promptIndex}].options[${optionIndex}].role_keys`,
      ).entries())
        requireKey(roles, key, `onboarding role[${index}]`);
      for (const [index, key] of array(
        option.channel_keys,
        `blueprint.onboarding.prompts[${promptIndex}].options[${optionIndex}].channel_keys`,
      ).entries())
        requireKey(channels, key, `onboarding channel[${index}]`);
    }
  }
  for (const [index, rule] of array(
    blueprint.automod?.rules,
    'blueprint.automod.rules',
  ).entries()) {
    for (const [actionIndex, action] of array(
      rule.actions,
      `blueprint.automod.rules[${index}].actions`,
    ).entries())
      if (action.alert_channel_key !== null && action.alert_channel_key !== undefined)
        requireKey(
          channels,
          action.alert_channel_key,
          `blueprint.automod.rules[${index}].actions[${actionIndex}].alert_channel_key`,
        );
    for (const [keyIndex, key] of array(
      rule.exempt_role_keys,
      `blueprint.automod.rules[${index}].exempt_role_keys`,
    ).entries())
      requireKey(roles, key, `automod exempt role[${keyIndex}]`);
    for (const [keyIndex, key] of array(
      rule.exempt_channel_keys,
      `blueprint.automod.rules[${index}].exempt_channel_keys`,
    ).entries())
      requireKey(channels, key, `automod exempt channel[${keyIndex}]`);
  }
  for (const [index, publication] of array(
    blueprint.components_v2?.publications,
    'blueprint.components_v2.publications',
  ).entries())
    requireKey(
      channels,
      publication.channel_key,
      `blueprint.components_v2.publications[${index}].channel_key`,
    );
  const scanPlaceholders = (value, path) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{channel:([a-z][a-z0-9_]{0,63})\}\}/g))
        requireKey(channels, match[1], `${path} channel placeholder`);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) scanPlaceholders(child, `${path}[${index}]`);
      return;
    }
    if (value !== null && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) scanPlaceholders(child, `${path}.${key}`);
  };
  for (const [index, publication] of array(
    blueprint.components_v2?.publications,
    'blueprint.components_v2.publications',
  ).entries())
    scanPlaceholders(
      publication.components,
      `blueprint.components_v2.publications[${index}].components`,
    );
}

function addOverwriteAllows(target, resourceId, overwrites, bindings, guildId, botId, path) {
  for (const [index, overwrite] of array(overwrites, path).entries()) {
    const subject = subjectReference(
      overwrite.subject,
      bindings,
      `${path}[${index}].subject`,
      guildId,
      botId,
    );
    const key = `${resourceId}:${subject.type}:${subject.id}`;
    const allow = BigInt(permissionBits(overwrite.allow, `${path}[${index}].allow`));
    target[key] = ((target[key] === undefined ? 0n : BigInt(target[key])) | allow).toString();
  }
}

function jsonOnly(value, path = 'expected', seen = new Set()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return;
  if (typeof value !== 'object' || seen.has(value)) fail(`${path} must contain only JSON values`);
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    fail(`${path} must be a plain object`);
  for (const [key, child] of Object.entries(value)) jsonOnly(child, `${path}.${key}`, seen);
}

export function buildBenchmarkExpectations({ blueprint, bindings, before, guildId, botId } = {}) {
  record(blueprint, 'blueprint');
  const guild = snowflake(guildId, 'guildId');
  const bot = snowflake(botId, 'botId');
  if (guild === bot) fail('guildId and botId must be different');
  const keys = expectedKeys(blueprint);
  const exact = exactBindings(bindings, keys);
  const beforeState = validateBefore(before, guild, bot);
  const adopted = adoptedAutomodIds(blueprint, exact.result, before, bot);
  const adoptedAutomod = adopted.ids;
  const adoptedAutomodIdsSet = new Set(adoptedAutomod);
  for (const id of exact.allIds) {
    const adopted = adoptedAutomodIdsSet.has(id);
    if (id === guild || id === bot || (beforeState.ids.has(id) && !adopted))
      fail(`generated ID ${id} already exists in the target snapshot`);
  }
  collectReferences(blueprint, exact.result, guild, bot);

  const generatedRolePermissions = Object.fromEntries(
    array(blueprint.roles, 'blueprint.roles').map((role, index) => [
      exact.result.roles[role.key],
      permissionBits(role.permissions, `blueprint.roles[${index}].permissions`),
    ]),
  );
  const allowedOverwriteAllows = {};
  const blueprintCategories = array(blueprint.categories, 'blueprint.categories');
  const blueprintChannels = array(blueprint.channels, 'blueprint.channels');
  const categoriesByKey = new Map(blueprintCategories.map((category) => [category.key, category]));
  for (const category of blueprintCategories)
    addOverwriteAllows(
      allowedOverwriteAllows,
      exact.result.categories[category.key],
      category.overwrites,
      exact.result,
      guild,
      bot,
      `blueprint.categories.${category.key}.overwrites`,
    );
  for (const channel of blueprintChannels) {
    const channelOverwrites = array(
      channel.overwrites,
      `blueprint.channels.${channel.key}.overwrites`,
    );
    const parent = categoriesByKey.get(channel.parent_key);
    const effectiveOverwrites =
      channelOverwrites.length > 0
        ? channelOverwrites
        : array(parent?.overwrites, `blueprint.categories.${channel.parent_key}.overwrites`);
    addOverwriteAllows(
      allowedOverwriteAllows,
      exact.result.channels[channel.key],
      effectiveOverwrites,
      exact.result,
      guild,
      bot,
      `blueprint.channels.${channel.key}.overwrites`,
    );
  }

  const generatedChannels = [
    ...keys.categories.map((key) => exact.result.categories[key]),
    ...keys.channels.map((key) => exact.result.channels[key]),
  ];
  const generated = {
    roles: keys.roles.map((key) => exact.result.roles[key]),
    channels: generatedChannels,
    automod_rules: keys.automod_rules
      .map((key) => exact.result.automod_rules[key])
      .filter((id) => !adoptedAutomodIdsSet.has(id)),
    messages: keys.publications.map((key) => exact.result.publications[key]),
  };
  const botRoleIds = beforeState.botRoleIds;
  const canary = {
    roles: array(before.roles, 'before.roles')
      .filter((role) => role.id !== guild && !botRoleIds.has(role.id) && role.managed !== true)
      .map((role) => role.id),
    channels: array(before.channels, 'before.channels').map((channel) => channel.id),
  };
  const foldedChannels = Object.fromEntries([
    ...Object.entries(exact.result.categories),
    ...Object.entries(exact.result.channels),
  ]);
  const expected = {
    guild_id: guild,
    bot_id: bot,
    generated,
    bindings: {
      roles: exact.result.roles,
      channels: foldedChannels,
      automod_rules: exact.result.automod_rules,
      publications: exact.result.publications,
    },
    adopted_automod_rules: [...adoptedAutomod],
    adopted_automod_trigger_types: adopted.triggerTypes,
    canary,
    generated_role_permissions: generatedRolePermissions,
    allowed_overwrite_allows: allowedOverwriteAllows,
    allowed_state_changes: { guild: true, onboarding: true, welcome: true },
  };
  jsonOnly(expected);
  return expected;
}
