import { assertBaselineArtifactIntegrity } from './artifact-store.mjs';
import { DiscordRestError } from './discord-rest.mjs';

const SNOWFLAKE = /^\d{17,20}$/;
const RESET_PREFIX = 'RESET_DISPOSABLE_GUILD:';
const CANARY_ROLE_NAME = '__discord_mcp_benchmark_canary_role__';
const CANARY_CHANNEL_NAME = '__discord_mcp_benchmark_canary_channel__';
const SCHEMA_VERSION = 1;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RESTORE_SETTLE_DELAYS_MS = Object.freeze([0, 250, 500, 1_000, 2_000, 4_000]);
const RESTORE_RETRY_PROOFS = new WeakMap();
const RESTORE_FAILURE_POLICIES = Object.freeze({
  RESTORE_PREFLIGHT_UNAVAILABLE: Object.freeze({
    retryable: true,
    preflightVerified: false,
    readbackMayConfirm: false,
  }),
  RESTORE_SAFETY_VIOLATION: Object.freeze({
    retryable: false,
    preflightVerified: false,
    readbackMayConfirm: false,
  }),
  RESTORE_EXECUTION_AMBIGUOUS: Object.freeze({
    retryable: true,
    preflightVerified: true,
    readbackMayConfirm: true,
  }),
  RESTORE_EXECUTION_REJECTED: Object.freeze({
    retryable: false,
    preflightVerified: true,
    readbackMayConfirm: false,
  }),
});

export class BenchmarkRestoreFailure extends Error {
  constructor(code, cause, retryProof = null) {
    const policy = RESTORE_FAILURE_POLICIES[code];
    if (policy === undefined) throw new TypeError('benchmark restore failure code is invalid');
    const message =
      code === 'RESTORE_SAFETY_VIOLATION' && cause instanceof Error
        ? `${code}: ${cause.message}`
        : code;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BenchmarkRestoreFailure';
    this.code = code;
    this.retryable = policy.retryable;
    this.preflightVerified = policy.preflightVerified;
    this.readbackMayConfirm = policy.readbackMayConfirm;
    Object.defineProperty(this, 'retryProof', {
      value: retryProof,
      enumerable: false,
      writable: false,
    });
  }
}

function restoreFailure(code, cause, retryProof = null) {
  return cause instanceof BenchmarkRestoreFailure
    ? cause
    : new BenchmarkRestoreFailure(code, cause, retryProof);
}

async function restoreExecution(operation, retryProof) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DiscordRestError && error.disposition === 'deterministic') {
      throw restoreFailure('RESTORE_EXECUTION_REJECTED', error, retryProof);
    }
    throw restoreFailure('RESTORE_EXECUTION_AMBIGUOUS', error, retryProof);
  }
}

async function restoreObservation(operation, retryProof) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DiscordRestError) {
      const code =
        error.disposition === 'ambiguous'
          ? 'RESTORE_EXECUTION_AMBIGUOUS'
          : 'RESTORE_EXECUTION_REJECTED';
      throw restoreFailure(code, error, retryProof);
    }
    throw restoreFailure('RESTORE_SAFETY_VIOLATION', error, retryProof);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value))
    throw new TypeError(`${label} must be a Discord snowflake`);
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function validateCommon({ guildId, botId, allowedGuildIds, confirmation }, action) {
  snowflake(guildId, 'guildId');
  snowflake(botId, 'botId');
  if (!Array.isArray(allowedGuildIds) || allowedGuildIds.length === 0) {
    throw new Error('allowedGuildIds must be a nonempty exact allowlist');
  }
  const allowed = new Set(
    allowedGuildIds.map((id, index) => snowflake(id, `allowedGuildIds[${index}]`)),
  );
  if (allowed.size !== allowedGuildIds.length || !allowed.has(guildId)) {
    throw new Error(`${action} guild is not in the exact allowlist`);
  }
  if (confirmation !== `${RESET_PREFIX}${guildId}`) {
    throw new Error('disposable guild confirmation is required');
  }
  return allowed;
}

function assertSnapshot(snapshot, guildId, botId) {
  if (!record(snapshot)) throw new Error('benchmark snapshot is malformed');
  if (snapshot.guild?.id !== guildId) throw new Error('benchmark snapshot guild identity mismatch');
  if (snapshot.bot?.user?.id !== botId) throw new Error('benchmark snapshot bot identity mismatch');
  if (
    !Array.isArray(snapshot.roles) ||
    !Array.isArray(snapshot.channels) ||
    !Array.isArray(snapshot.automod_rules)
  ) {
    throw new Error('benchmark snapshot inventory is malformed');
  }
  const all = [...snapshot.roles, ...snapshot.channels, ...snapshot.automod_rules];
  for (const [index, item] of all.entries()) snowflake(item?.id, `snapshot resource ${index}`);
  const roleIds = new Set(snapshot.roles.map((item) => item.id));
  const channelIds = new Set(snapshot.channels.map((item) => item.id));
  if (!roleIds.has(guildId)) throw new Error('snapshot is missing @everyone role');
  for (const role of snapshot.roles) {
    if (role.guild_id !== undefined && role.guild_id !== guildId)
      throw new Error('role guild mismatch');
    if (
      typeof role.managed !== 'boolean' ||
      typeof role.permissions !== 'string' ||
      !/^\d+$/.test(role.permissions)
    ) {
      throw new Error('snapshot role security fields are malformed');
    }
  }
  for (const channel of snapshot.channels) {
    if (channel.guild_id !== guildId) throw new Error('channel guild mismatch');
    if (!Number.isInteger(channel.type) || channel.type < 0)
      throw new Error('snapshot channel type is malformed');
    if (
      channel.parent_id !== null &&
      channel.parent_id !== undefined &&
      !channelIds.has(channel.parent_id)
    ) {
      throw new Error('snapshot channel parent is foreign');
    }
  }
  for (const rule of snapshot.automod_rules) {
    if (rule.guild_id !== undefined && rule.guild_id !== guildId)
      throw new Error('AutoMod rule guild mismatch');
  }
  const botRoles = new Set(snapshot.bot.roles ?? []);
  for (const roleId of botRoles) snowflake(roleId, 'bot role');
  return { roleIds, channelIds, botRoles };
}

function cloneJson(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('value is not JSON serializable');
    return JSON.parse(text);
  } catch {
    throw new Error('benchmark baseline must be JSON serializable');
  }
}

function mutationReason(reason, fallback) {
  const value = reason ?? fallback;
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('audit reason is required');
  return value.slice(0, 480);
}

async function mutate(rest, method, path, options) {
  requiredFunction(rest?.request, 'rest.request');
  const requestOptions = { ...options };
  if (method === 'POST') requestOptions.retry = false;
  return rest.request(method, path, requestOptions);
}

function discordErrorCode(error) {
  const direct = error?.code ?? error?.body?.code ?? error?.data?.code;
  if (direct !== undefined && direct !== null && /^\d+$/.test(String(direct))) {
    return String(direct);
  }
  const match = String(error?.message ?? error).match(/\bcode\s+(\d+)\b/i);
  return match?.[1] ?? null;
}

function isProtectedMentionSpamRule(rule, botId) {
  return record(rule) && rule.trigger_type === 5 && rule.creator_id === botId;
}

function protectedRulePatchBody(rule) {
  return {
    name: rule.name,
    event_type: rule.event_type,
    trigger_metadata: cloneJson(rule.trigger_metadata ?? {}),
    actions: [{ type: 1 }],
    enabled: false,
    exempt_roles: [],
    exempt_channels: [],
  };
}

function exactAutoModRulePatchBody(rule) {
  return {
    name: rule.name,
    event_type: rule.event_type,
    trigger_metadata: cloneJson(rule.trigger_metadata ?? {}),
    actions: cloneJson(rule.actions ?? []),
    enabled: rule.enabled,
    exempt_roles: cloneJson(rule.exempt_roles ?? []),
    exempt_channels: cloneJson(rule.exempt_channels ?? []),
  };
}

function responseId(response, guildId, kind) {
  if (!record(response)) throw new Error(`${kind} response is malformed`);
  const id = snowflake(response.id, `${kind} response id`);
  if (response.guild_id !== undefined && response.guild_id !== guildId)
    throw new Error(`${kind} response guild mismatch`);
  return id;
}

function responseGuild(response, guildId, kind) {
  if (!record(response) || response.id !== guildId)
    throw new Error(`${kind} response guild identity mismatch`);
  if (response.guild_id !== undefined && response.guild_id !== guildId)
    throw new Error(`${kind} response guild mismatch`);
  return response;
}

function responseGuildScoped(response, guildId, kind) {
  if (!record(response) || response.guild_id !== guildId)
    throw new Error(`${kind} response guild identity mismatch`);
  return response;
}

function responseOnboarding(response, guildId, kind) {
  responseGuildScoped(response, guildId, kind);
  if (
    response.enabled !== false ||
    response.mode !== 0 ||
    !Array.isArray(response.prompts) ||
    response.prompts.length !== 0 ||
    !Array.isArray(response.default_channel_ids) ||
    response.default_channel_ids.length !== 0
  ) {
    throw new Error(`${kind} response is not disabled and empty`);
  }
  return response;
}

function responseWelcome(response, kind) {
  if (
    !record(response) ||
    response.description !== null ||
    !Array.isArray(response.welcome_channels) ||
    response.welcome_channels.length !== 0
  ) {
    throw new Error(`${kind} response is not empty`);
  }
  return response;
}

function roleById(snapshot, id) {
  return snapshot.roles.find((item) => item.id === id);
}
function channelById(snapshot, id) {
  return snapshot.channels.find((item) => item.id === id);
}

function compareDiscordRoles(left, right) {
  const leftPosition = left.position ?? 0;
  const rightPosition = right.position ?? 0;
  if (leftPosition !== rightPosition) return leftPosition - rightPosition;
  if (left.id === right.id) return 0;
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

function highestDiscordRole(roles) {
  let highest = null;
  for (const role of roles) {
    if (highest === null || compareDiscordRoles(role, highest) > 0) highest = role;
  }
  return highest;
}

function roleAtOrAbove(role, highest) {
  return highest === null || compareDiscordRoles(role, highest) >= 0;
}

function canaryFromSnapshot(snapshot, kind, name) {
  const items = kind === 'role' ? snapshot.roles : snapshot.channels;
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1) throw new Error(`duplicate ${kind} canary marker`);
  return matches[0] ?? null;
}

function validateCanary(snapshot, role, channel, guildId) {
  const canaryRole = roleById(snapshot, role);
  const canaryChannel = channelById(snapshot, channel);
  if (
    !canaryRole ||
    canaryRole.managed ||
    canaryRole.name !== CANARY_ROLE_NAME ||
    canaryRole.permissions !== '0'
  ) {
    throw new Error('canary role is missing or unsafe');
  }
  if (
    !canaryChannel ||
    canaryChannel.guild_id !== guildId ||
    canaryChannel.name !== CANARY_CHANNEL_NAME ||
    canaryChannel.type !== 0 ||
    (canaryChannel.permission_overwrites ?? []).length !== 0
  ) {
    throw new Error('canary channel is missing or unsafe');
  }
}

function baselineView(snapshot, guildId, botId, canaryRoleId, canaryChannelId, fingerprint, runId) {
  const highestBotRole = highestDiscordRole(
    snapshot.roles.filter((item) => (snapshot.bot.roles ?? []).includes(item.id)),
  );
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'discord-mcp-benchmark-baseline',
    guild_id: guildId,
    bot_id: botId,
    run_id: runId,
    fingerprint,
    canary: { role_id: canaryRoleId, channel_id: canaryChannelId },
    guild_fields: {
      id: snapshot.guild.id,
      name: snapshot.guild.name,
      description: snapshot.guild.description ?? null,
      preferred_locale: snapshot.guild.preferred_locale,
      verification_level: snapshot.guild.verification_level,
      default_message_notifications: snapshot.guild.default_message_notifications,
      explicit_content_filter: snapshot.guild.explicit_content_filter,
      rules_channel_id: snapshot.guild.rules_channel_id ?? canaryChannelId,
      public_updates_channel_id: snapshot.guild.public_updates_channel_id ?? canaryChannelId,
      safety_alerts_channel_id: snapshot.guild.safety_alerts_channel_id ?? canaryChannelId,
      features: [...(snapshot.guild.features ?? [])].sort(),
    },
    preserved_role_ids: snapshot.roles
      .filter(
        (role) =>
          role.id === guildId ||
          role.id === canaryRoleId ||
          role.managed ||
          (snapshot.bot.roles ?? []).includes(role.id) ||
          roleAtOrAbove(role, highestBotRole),
      )
      .map((role) => role.id)
      .sort(),
    baseline_snapshot: cloneJson(snapshot),
  };
}

function validateBaselineRecord(baseline, integrityKey) {
  if (
    !record(baseline) ||
    baseline.schema_version !== SCHEMA_VERSION ||
    baseline.kind !== 'discord-mcp-benchmark-baseline'
  )
    throw new Error('benchmark baseline record is malformed');
  snowflake(baseline.guild_id, 'baseline.guild_id');
  snowflake(baseline.bot_id, 'baseline.bot_id');
  if (
    baseline.run_id !== undefined &&
    (typeof baseline.run_id !== 'string' || !RUN_ID.test(baseline.run_id))
  ) {
    throw new Error('baseline run_id is malformed');
  }
  if (typeof integrityKey !== 'string' || integrityKey.trim() === '') {
    throw new Error('baseline integrity key is required');
  }
  assertBaselineArtifactIntegrity(baseline, {
    guildId: baseline.guild_id,
    integrityKey,
  });
  if (!/^sha256:[a-f0-9]{64}$/.test(baseline.fingerprint ?? ''))
    throw new Error('baseline fingerprint is malformed');
  snowflake(baseline.canary?.role_id, 'baseline.canary.role_id');
  snowflake(baseline.canary?.channel_id, 'baseline.canary.channel_id');
  if (!record(baseline.guild_fields) || baseline.guild_fields.id !== baseline.guild_id) {
    throw new Error('baseline guild fields are malformed');
  }
  for (const field of [
    'rules_channel_id',
    'public_updates_channel_id',
    'safety_alerts_channel_id',
  ]) {
    snowflake(baseline.guild_fields[field], `baseline.guild_fields.${field}`);
  }
  if (typeof baseline.guild_fields.name !== 'string' || baseline.guild_fields.name === '')
    throw new Error('baseline guild name is malformed');
  if (
    baseline.guild_fields.description !== null &&
    typeof baseline.guild_fields.description !== 'string'
  )
    throw new Error('baseline guild description is malformed');
  if (typeof baseline.guild_fields.preferred_locale !== 'string')
    throw new Error('baseline guild locale is malformed');
  for (const field of [
    'verification_level',
    'default_message_notifications',
    'explicit_content_filter',
  ])
    if (!Number.isInteger(baseline.guild_fields[field]) || baseline.guild_fields[field] < 0)
      throw new Error(`baseline guild ${field} is malformed`);
  if (
    !Array.isArray(baseline.guild_fields.features) ||
    !baseline.guild_fields.features.includes('COMMUNITY')
  )
    throw new Error('baseline guild must have Community enabled');
  if (!Array.isArray(baseline.preserved_role_ids))
    throw new Error('baseline preserved roles are malformed');
  for (const id of baseline.preserved_role_ids) snowflake(id, 'baseline preserved role');
  if (!record(baseline.baseline_snapshot)) throw new Error('baseline snapshot is missing');
  assertSnapshot(baseline.baseline_snapshot, baseline.guild_id, baseline.bot_id);
  validateCanary(
    baseline.baseline_snapshot,
    baseline.canary.role_id,
    baseline.canary.channel_id,
    baseline.guild_id,
  );
  assertDisabledCommunityState(baseline.baseline_snapshot, baseline.guild_id);
  if (
    baseline.baseline_snapshot.publication_history_complete?.[baseline.canary.channel_id] !== true
  )
    throw new Error('baseline canary message history is incomplete');
  if ((baseline.baseline_snapshot.recent_messages?.[baseline.canary.channel_id] ?? []).length !== 0)
    throw new Error('baseline canary message history is not empty');
}

function verifyIdentityAndCanary(snapshot, baseline) {
  assertSnapshot(snapshot, baseline.guild_id, baseline.bot_id);
  validateCanary(snapshot, baseline.canary.role_id, baseline.canary.channel_id, baseline.guild_id);
  return snapshot;
}

function assertCommunityEnabled(snapshot) {
  if (!Array.isArray(snapshot.guild?.features) || !snapshot.guild.features.includes('COMMUNITY'))
    throw new Error('benchmark guild must have Community enabled');
  if (snapshot.onboarding === null || snapshot.welcome_screen === null)
    throw new Error('Community onboarding and welcome state are unavailable');
}

function assertDisabledCommunityState(snapshot, guildId) {
  assertCommunityEnabled(snapshot);
  const onboarding = snapshot.onboarding;
  if (
    onboarding.guild_id !== guildId ||
    onboarding.enabled !== false ||
    !Array.isArray(onboarding.prompts) ||
    onboarding.prompts.length !== 0 ||
    !Array.isArray(onboarding.default_channel_ids) ||
    onboarding.default_channel_ids.length !== 0 ||
    onboarding.mode !== 0
  )
    throw new Error('baseline onboarding is not disabled and empty');
  const welcome = snapshot.welcome_screen;
  if (
    snapshot.guild.features.includes('WELCOME_SCREEN_ENABLED') ||
    !Array.isArray(welcome.welcome_channels) ||
    welcome.welcome_channels.length !== 0 ||
    welcome.description !== null
  )
    throw new Error('baseline welcome screen is not disabled and empty');
}

async function readCanarySnapshot(readSnapshot, guildId, botId, canaryChannelId) {
  const snapshot = await readSnapshot({
    guildId,
    botId,
    messageChannelIds: [canaryChannelId],
  });
  if (snapshot.publication_history_complete?.[canaryChannelId] !== true)
    throw new Error('canary message history is incomplete');
  if ((snapshot.recent_messages?.[canaryChannelId] ?? []).length !== 0)
    throw new Error('canary channel must have empty message history');
  return snapshot;
}

function assertBaselineResourcesPresent(snapshot, baseline) {
  const current = {
    roles: new Set(snapshot.roles.map((item) => item.id)),
    channels: new Set(snapshot.channels.map((item) => item.id)),
    automod: new Set(snapshot.automod_rules.map((item) => item.id)),
  };
  const expected = baselineIds(baseline);
  if (
    [...expected.roles].some((id) => !current.roles.has(id)) ||
    [...expected.channels].some((id) => !current.channels.has(id)) ||
    [...expected.automod].some((id) => !current.automod.has(id))
  ) {
    throw new Error('BASELINE_RESOURCE_DRIFT');
  }
}

export async function verifyBenchmarkBaseline({
  readSnapshot,
  snapshotFingerprint,
  baseline,
  integrityKey,
}) {
  requiredFunction(readSnapshot, 'readSnapshot');
  requiredFunction(snapshotFingerprint, 'snapshotFingerprint');
  validateBaselineRecord(baseline, integrityKey);
  const snapshot = await readCanarySnapshot(
    readSnapshot,
    baseline.guild_id,
    baseline.bot_id,
    baseline.canary.channel_id,
  );
  verifyIdentityAndCanary(snapshot, baseline);
  assertDisabledCommunityState(snapshot, baseline.guild_id);
  const fingerprint = snapshotFingerprint(snapshot);
  if (fingerprint !== baseline.fingerprint) throw new Error('BASELINE_FINGERPRINT_DRIFT');
  return { verified: true, guild_id: baseline.guild_id, bot_id: baseline.bot_id, fingerprint };
}

function uniqueBoundIds(values, label) {
  if (!record(values)) throw new Error(`${label} bindings are malformed`);
  const ids = [];
  for (const [key, value] of Object.entries(values)) {
    const id = typeof value === 'string' ? value : value?.id;
    snowflake(id, `${label}.${key}`);
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new Error('duplicate cleanup binding');
  return ids;
}

function cleanupBindings(cleanup, baseline) {
  if (!record(cleanup) || !record(cleanup.bindings))
    throw new Error('cleanup bindings are required');
  if (cleanup.guild_id !== baseline.guild_id || cleanup.bot_id !== baseline.bot_id) {
    throw new Error('cleanup target does not match the exact baseline target');
  }
  const bindings = cleanup.bindings;
  const roles = uniqueBoundIds(bindings.roles ?? {}, 'roles');
  const categories = uniqueBoundIds(bindings.categories ?? {}, 'categories');
  const channels = uniqueBoundIds(bindings.channels ?? {}, 'channels');
  const automod = uniqueBoundIds(bindings.automod_rules ?? {}, 'automod_rules');
  const publicationValues = uniqueBoundIds(bindings.publications ?? {}, 'publications');
  if (!Array.isArray(cleanup.publication_targets))
    throw new Error('cleanup.publication_targets are required');
  const publicationTargets = cleanup.publication_targets.map((target, index) => {
    if (!record(target)) throw new Error(`publication_targets[${index}] is malformed`);
    return {
      channel_id: snowflake(target.channel_id, `publication_targets[${index}].channel_id`),
      message_id: snowflake(target.message_id, `publication_targets[${index}].message_id`),
    };
  });
  const targetMessages = publicationTargets.map((target) => target.message_id);
  if (
    new Set(targetMessages).size !== targetMessages.length ||
    targetMessages.length !== publicationValues.length ||
    targetMessages.some((id) => !publicationValues.includes(id)) ||
    publicationValues.some((id) => !targetMessages.includes(id))
  )
    throw new Error('publication targets do not exactly match publication bindings');
  if (publicationTargets.some((target) => !channels.includes(target.channel_id))) {
    throw new Error('publication target channel is not a cleanup channel binding');
  }
  const all = [...roles, ...categories, ...channels, ...automod, ...publicationValues];
  if (new Set(all).size !== all.length) throw new Error('cleanup bindings overlap');
  return { roles, categories, channels, automod, messages: publicationValues, publicationTargets };
}

function cleanupIdentity(ids, baseline) {
  return JSON.stringify({
    guild_id: baseline.guild_id,
    bot_id: baseline.bot_id,
    baseline_fingerprint: baseline.fingerprint,
    roles: [...ids.roles].sort(),
    categories: [...ids.categories].sort(),
    channels: [...ids.channels].sort(),
    automod: [...ids.automod].sort(),
    messages: [...ids.messages].sort(),
    publication_targets: ids.publicationTargets
      .map((target) => `${target.channel_id}:${target.message_id}`)
      .sort(),
  });
}

function allowMissingFromRetryProof(retryProof, identity) {
  if (retryProof === null) return false;
  if (!record(retryProof) || RESTORE_RETRY_PROOFS.get(retryProof) !== identity) {
    throw new Error('restore retry proof is missing or does not match cleanup');
  }
  return true;
}

function issueRestoreRetryProof(identity) {
  const proof = Object.freeze({});
  RESTORE_RETRY_PROOFS.set(proof, identity);
  return proof;
}

function baselineIds(baseline) {
  const snapshot = baseline.baseline_snapshot;
  return {
    roles: new Set((snapshot.roles ?? []).map((item) => item.id)),
    channels: new Set((snapshot.channels ?? []).map((item) => item.id)),
    automod: new Set((snapshot.automod_rules ?? []).map((item) => item.id)),
  };
}

function assertNoBaselineOverlap(ids, baseline) {
  const base = baselineIds(baseline);
  for (const id of ids.roles)
    if (base.roles.has(id)) throw new Error('cleanup targets a baseline role');
  for (const id of [...ids.categories, ...ids.channels])
    if (base.channels.has(id)) throw new Error('cleanup targets a baseline channel');
  for (const id of ids.automod) {
    if (!base.automod.has(id)) continue;
    const rule = baseline.baseline_snapshot.automod_rules.find((item) => item.id === id);
    if (!isProtectedMentionSpamRule(rule, baseline.bot_id))
      throw new Error('cleanup targets a baseline AutoMod rule');
  }
}

function assertCleanupInventory(ids, snapshot, baseline, allowMissingCleanupResources) {
  assertNoBaselineOverlap(ids, baseline);
  const base = baselineIds(baseline);
  const highestBotRole = highestDiscordRole(
    snapshot.roles.filter((item) => (snapshot.bot.roles ?? []).includes(item.id)),
  );
  for (const id of ids.roles) {
    const role = roleById(snapshot, id);
    if (!role) {
      if (allowMissingCleanupResources) continue;
      throw new Error('cleanup role is missing before a verified restore retry');
    }
    if (role.managed || (snapshot.bot.roles ?? []).includes(id) || id === snapshot.guild.id)
      throw new Error('foreign, managed, or bot-assigned role binding');
    if (roleAtOrAbove(role, highestBotRole))
      throw new Error('cleanup role is not below the bot role');
  }
  for (const id of [...ids.categories, ...ids.channels]) {
    const channel = channelById(snapshot, id);
    if (!channel) {
      if (allowMissingCleanupResources) continue;
      throw new Error('cleanup channel is missing before a verified restore retry');
    }
    if (channel.guild_id !== baseline.guild_id || channel.id === baseline.canary.channel_id)
      throw new Error('foreign or canary channel binding');
    if (ids.categories.includes(id) && channel.type !== 4)
      throw new Error('category binding is not a category');
    if (ids.channels.includes(id) && channel.type === 4)
      throw new Error('channel binding is a category');
  }
  for (const id of ids.automod) {
    const rule = snapshot.automod_rules.find((item) => item.id === id);
    if (!rule) {
      if (allowMissingCleanupResources) continue;
      throw new Error('cleanup AutoMod rule is missing before a verified restore retry');
    }
    if (rule.guild_id !== baseline.guild_id) throw new Error('foreign AutoMod binding');
    if (
      base.automod.has(id) &&
      !isProtectedMentionSpamRule(
        baseline.baseline_snapshot.automod_rules.find((item) => item.id === id),
        baseline.bot_id,
      )
    )
      throw new Error('cleanup targets a baseline AutoMod rule');
    if (base.automod.has(id) && !isProtectedMentionSpamRule(rule, baseline.bot_id))
      throw new Error('cleanup targets a baseline AutoMod rule');
  }
  const boundResources = new Set([...ids.roles, ...ids.categories, ...ids.channels]);
  const orphans = snapshot.roles
    .filter((item) => !base.roles.has(item.id) && !boundResources.has(item.id))
    .concat(
      snapshot.channels.filter(
        (item) => !base.channels.has(item.id) && !boundResources.has(item.id),
      ),
    )
    .concat(
      snapshot.automod_rules.filter(
        (item) => !base.automod.has(item.id) && !ids.automod.includes(item.id),
      ),
    );
  if (orphans.length > 0) throw new Error('BASELINE_ORPHAN_DRIFT');
}

export async function restoreBenchmarkBaseline({
  rest,
  readSnapshot,
  snapshotFingerprint,
  baseline,
  allowedGuildIds,
  expectedBotId,
  confirmation,
  cleanup,
  reason,
  retryProof = null,
  sleep = wait,
  integrityKey,
}) {
  let ids;
  let cleanupIdentityKey;
  let allowMissingCleanupResources;
  try {
    requiredFunction(readSnapshot, 'readSnapshot');
    requiredFunction(snapshotFingerprint, 'snapshotFingerprint');
    requiredFunction(rest?.request, 'rest.request');
    requiredFunction(sleep, 'sleep');
    validateBaselineRecord(baseline, integrityKey);
    validateCommon(
      {
        guildId: baseline.guild_id,
        botId: baseline.bot_id,
        allowedGuildIds,
        confirmation,
      },
      'restorer',
    );
    if (snowflake(expectedBotId, 'expectedBotId') !== baseline.bot_id) {
      throw new Error('restorer bot does not match the exact expected bot');
    }
    ids = cleanupBindings(cleanup, baseline);
    cleanupIdentityKey = cleanupIdentity(ids, baseline);
    allowMissingCleanupResources = allowMissingFromRetryProof(retryProof, cleanupIdentityKey);
  } catch (error) {
    throw restoreFailure('RESTORE_SAFETY_VIOLATION', error);
  }
  let snapshot;
  try {
    snapshot = await readSnapshot({
      guildId: baseline.guild_id,
      botId: baseline.bot_id,
      messageChannelIds: [
        ...new Set([
          baseline.canary.channel_id,
          ...ids.publicationTargets.map((target) => target.channel_id),
        ]),
      ],
      allowMissingMessageChannelIds: true,
    });
  } catch (error) {
    const code =
      error instanceof DiscordRestError && error.disposition === 'ambiguous'
        ? 'RESTORE_PREFLIGHT_UNAVAILABLE'
        : 'RESTORE_SAFETY_VIOLATION';
    throw restoreFailure(code, error);
  }
  let messageTargets;
  let auditReason;
  let routeBody;
  try {
    verifyIdentityAndCanary(snapshot, baseline);
    if (
      snapshot.publication_history_complete?.[baseline.canary.channel_id] !== true ||
      (snapshot.recent_messages?.[baseline.canary.channel_id] ?? []).length !== 0
    ) {
      throw new Error('BASELINE_CANARY_MESSAGE_DRIFT');
    }
    assertBaselineResourcesPresent(snapshot, baseline);
    assertCleanupInventory(ids, snapshot, baseline, allowMissingCleanupResources);
    const base = baselineIds(baseline);
    for (const target of ids.publicationTargets) {
      const channel = channelById(snapshot, target.channel_id);
      if (!channel) continue;
      if (
        !ids.channels.includes(target.channel_id) ||
        ![0, 5].includes(channel.type) ||
        base.channels.has(target.channel_id)
      )
        throw new Error('publication target channel is foreign or not frozen');
    }
    messageTargets = [];
    for (const target of ids.publicationTargets) {
      const channel = channelById(snapshot, target.channel_id);
      if (!channel) continue;
      if (snapshot.publication_history_complete?.[target.channel_id] !== true)
        throw new Error('publication message history is incomplete');
      const found = (snapshot.recent_messages?.[target.channel_id] ?? []).find(
        (item) => item.id === target.message_id,
      );
      if (!found) {
        if (allowMissingCleanupResources) continue;
        throw new Error('publication message is missing before a verified restore retry');
      }
      if (
        found.author?.id !== baseline.bot_id ||
        (found.guild_id !== undefined && found.guild_id !== baseline.guild_id) ||
        found.channel_id !== target.channel_id
      )
        throw new Error('publication message is not verified bot-authored');
      messageTargets.push(target);
    }
    auditReason = mutationReason(reason, `discord-mcp benchmark restore ${baseline.guild_id}`);
    routeBody = {
      name: baseline.guild_fields.name,
      description: baseline.guild_fields.description,
      preferred_locale: baseline.guild_fields.preferred_locale,
      verification_level: baseline.guild_fields.verification_level,
      default_message_notifications: baseline.guild_fields.default_message_notifications,
      explicit_content_filter: baseline.guild_fields.explicit_content_filter,
      rules_channel_id: baseline.guild_fields.rules_channel_id,
      public_updates_channel_id: baseline.guild_fields.public_updates_channel_id,
      safety_alerts_channel_id: baseline.guild_fields.safety_alerts_channel_id,
      features: baseline.guild_fields.features,
    };
  } catch (error) {
    throw restoreFailure('RESTORE_SAFETY_VIOLATION', error);
  }
  const activeRetryProof = issueRestoreRetryProof(cleanupIdentityKey);
  const execute = (operation) => restoreExecution(operation, activeRetryProof);
  const observe = (operation) => restoreObservation(operation, activeRetryProof);
  if (snapshot.onboarding !== null)
    await execute(async () =>
      responseOnboarding(
        await mutate(rest, 'PUT', `/guilds/${baseline.guild_id}/onboarding`, {
          body: { prompts: [], default_channel_ids: [], enabled: false, mode: 0 },
          reason: auditReason,
        }),
        baseline.guild_id,
        'onboarding restore',
      ),
    );
  if (snapshot.welcome_screen !== null)
    await execute(async () =>
      responseWelcome(
        await mutate(rest, 'PATCH', `/guilds/${baseline.guild_id}/welcome-screen`, {
          body: { enabled: false, welcome_channels: [], description: null },
          reason: auditReason,
        }),
        'welcome restore',
      ),
    );
  const guildResponse = await execute(async () =>
    responseGuild(
      await mutate(rest, 'PATCH', `/guilds/${baseline.guild_id}`, {
        body: routeBody,
        reason: auditReason,
      }),
      baseline.guild_id,
      'guild restore',
    ),
  );
  if (
    guildResponse.rules_channel_id !== baseline.guild_fields.rules_channel_id ||
    guildResponse.public_updates_channel_id !== baseline.guild_fields.public_updates_channel_id ||
    guildResponse.safety_alerts_channel_id !== baseline.guild_fields.safety_alerts_channel_id ||
    !Array.isArray(guildResponse.features) ||
    !guildResponse.features.includes('COMMUNITY')
  ) {
    throw restoreFailure(
      'RESTORE_EXECUTION_AMBIGUOUS',
      new Error('guild restore response did not preserve the baseline Community routes'),
      activeRetryProof,
    );
  }
  for (const target of messageTargets)
    await execute(() =>
      mutate(rest, 'DELETE', `/channels/${target.channel_id}/messages/${target.message_id}`, {
        reason: auditReason,
      }),
    );
  let deletedAutoModRules = 0;
  for (const id of ids.automod) {
    const currentRule = snapshot.automod_rules.find((item) => item.id === id);
    if (!currentRule) continue;
    const baselineRule = baseline.baseline_snapshot.automod_rules.find((item) => item.id === id);
    if (
      isProtectedMentionSpamRule(baselineRule, baseline.bot_id) &&
      isProtectedMentionSpamRule(currentRule, baseline.bot_id)
    ) {
      await execute(() =>
        mutate(rest, 'PATCH', `/guilds/${baseline.guild_id}/auto-moderation/rules/${id}`, {
          body: exactAutoModRulePatchBody(baselineRule),
          reason: auditReason,
        }),
      );
      continue;
    }
    await execute(() =>
      mutate(rest, 'DELETE', `/guilds/${baseline.guild_id}/auto-moderation/rules/${id}`, {
        reason: auditReason,
      }),
    );
    deletedAutoModRules += 1;
  }
  const channelObjects = [...ids.channels, ...ids.categories]
    .map((id) => channelById(snapshot, id))
    .filter((channel) => channel !== undefined);
  const childFirst = channelObjects.sort((left, right) => {
    const leftCategory = left.type === 4 ? 1 : 0;
    const rightCategory = right.type === 4 ? 1 : 0;
    return leftCategory - rightCategory;
  });
  for (const channel of childFirst)
    await execute(() => mutate(rest, 'DELETE', `/channels/${channel.id}`, { reason: auditReason }));
  const roleIds = ids.roles.filter((id) => roleById(snapshot, id) !== undefined);
  for (const id of roleIds)
    await execute(() =>
      mutate(rest, 'DELETE', `/guilds/${baseline.guild_id}/roles/${id}`, {
        reason: auditReason,
      }),
    );
  let fingerprint;
  let restored = false;
  for (let attempt = 0; attempt < RESTORE_SETTLE_DELAYS_MS.length; attempt += 1) {
    const delay = RESTORE_SETTLE_DELAYS_MS[attempt];
    if (delay > 0) await execute(() => sleep(delay));
    snapshot = await observe(() =>
      readCanarySnapshot(
        readSnapshot,
        baseline.guild_id,
        baseline.bot_id,
        baseline.canary.channel_id,
      ),
    );
    await observe(() => verifyIdentityAndCanary(snapshot, baseline));
    let communityStateExact = true;
    try {
      assertDisabledCommunityState(snapshot, baseline.guild_id);
    } catch {
      communityStateExact = false;
    }
    fingerprint = await observe(() => snapshotFingerprint(snapshot));
    restored = communityStateExact && fingerprint === baseline.fingerprint;
    if (restored) break;
  }
  if (!restored) {
    throw restoreFailure(
      'RESTORE_EXECUTION_AMBIGUOUS',
      new Error('BASELINE_RESTORE_QUARANTINE_FINGERPRINT_DRIFT'),
      activeRetryProof,
    );
  }
  const result = {
    restored: true,
    guild_id: baseline.guild_id,
    bot_id: baseline.bot_id,
    fingerprint,
    deleted: {
      messages: messageTargets.length,
      automod_rules: deletedAutoModRules,
      channels: channelObjects.length,
      roles: roleIds.length,
    },
  };
  Object.defineProperty(result, 'retryProof', {
    value: activeRetryProof,
    enumerable: false,
    writable: false,
  });
  return result;
}

export async function initializeBenchmarkBaseline({
  rest,
  readSnapshot,
  snapshotFingerprint,
  guildId,
  botId,
  allowedGuildIds,
  confirmation,
  runId,
}) {
  requiredFunction(readSnapshot, 'readSnapshot');
  requiredFunction(snapshotFingerprint, 'snapshotFingerprint');
  requiredFunction(rest?.request, 'rest.request');
  validateCommon({ guildId, botId, allowedGuildIds, confirmation }, 'initializer');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  let snapshot = await readSnapshot({ guildId, botId });
  assertSnapshot(snapshot, guildId, botId);
  let canaryRole = canaryFromSnapshot(snapshot, 'role', CANARY_ROLE_NAME);
  let canaryChannel = canaryFromSnapshot(snapshot, 'channel', CANARY_CHANNEL_NAME);
  if (canaryRole && (canaryRole.managed || canaryRole.permissions !== '0'))
    throw new Error('existing canary role is unsafe');
  if (canaryChannel && (canaryChannel.guild_id !== guildId || canaryChannel.type !== 0))
    throw new Error('existing canary channel is unsafe');
  const reason = `discord-mcp benchmark baseline ${runId}`;
  if (!canaryRole) {
    canaryRole = await mutate(rest, 'POST', `/guilds/${guildId}/roles`, {
      body: { name: CANARY_ROLE_NAME, permissions: '0', mentionable: false, hoist: false },
      reason,
    });
    const id = responseId(canaryRole, guildId, 'canary role');
    canaryRole = { id, name: CANARY_ROLE_NAME, permissions: '0', managed: false, position: 0 };
  }
  if (!canaryChannel) {
    canaryChannel = await mutate(rest, 'POST', `/guilds/${guildId}/channels`, {
      body: { name: CANARY_CHANNEL_NAME, type: 0, permission_overwrites: [] },
      reason,
    });
    const id = responseId(canaryChannel, guildId, 'canary channel');
    canaryChannel = {
      id,
      guild_id: guildId,
      name: CANARY_CHANNEL_NAME,
      type: 0,
      parent_id: null,
      permission_overwrites: [],
    };
  }
  const canaryRoleId = canaryRole.id;
  const canaryChannelId = canaryChannel.id;
  snapshot = await readCanarySnapshot(readSnapshot, guildId, botId, canaryChannelId);
  assertSnapshot(snapshot, guildId, botId);
  validateCanary(snapshot, canaryRoleId, canaryChannelId, guildId);
  const verificationLevel = Math.max(snapshot.guild.verification_level ?? 0, 1);
  const defaultMessageNotifications = Math.max(
    snapshot.guild.default_message_notifications ?? 0,
    1,
  );
  const explicitContentFilter = Math.max(snapshot.guild.explicit_content_filter ?? 0, 2);
  const routeResponse = await mutate(rest, 'PATCH', `/guilds/${guildId}`, {
    body: {
      verification_level: verificationLevel,
      default_message_notifications: defaultMessageNotifications,
      explicit_content_filter: explicitContentFilter,
      rules_channel_id: canaryChannelId,
      public_updates_channel_id: canaryChannelId,
      safety_alerts_channel_id: canaryChannelId,
      features: [...new Set([...(snapshot.guild.features ?? []), 'COMMUNITY'])].sort(),
    },
    reason,
  });
  const configuredGuild = responseGuild(routeResponse, guildId, 'guild Community route');
  if (
    configuredGuild.verification_level !== verificationLevel ||
    configuredGuild.default_message_notifications !== defaultMessageNotifications ||
    configuredGuild.explicit_content_filter !== explicitContentFilter ||
    configuredGuild.rules_channel_id !== canaryChannelId ||
    configuredGuild.public_updates_channel_id !== canaryChannelId ||
    configuredGuild.safety_alerts_channel_id !== canaryChannelId ||
    !Array.isArray(configuredGuild.features) ||
    !configuredGuild.features.includes('COMMUNITY')
  ) {
    throw new Error('guild Community route response is malformed');
  }
  responseOnboarding(
    await mutate(rest, 'PUT', `/guilds/${guildId}/onboarding`, {
      body: { prompts: [], default_channel_ids: [], enabled: false, mode: 0 },
      reason,
    }),
    guildId,
    'onboarding disable',
  );
  responseWelcome(
    await mutate(rest, 'PATCH', `/guilds/${guildId}/welcome-screen`, {
      body: { enabled: false, welcome_channels: [], description: null },
      reason,
    }),
    'welcome disable',
  );
  for (const rule of snapshot.automod_rules) {
    try {
      await mutate(rest, 'DELETE', `/guilds/${guildId}/auto-moderation/rules/${rule.id}`, {
        reason,
      });
    } catch (error) {
      if (discordErrorCode(error) !== '200006' || !isProtectedMentionSpamRule(rule, botId)) {
        throw error;
      }
      await mutate(rest, 'PATCH', `/guilds/${guildId}/auto-moderation/rules/${rule.id}`, {
        body: protectedRulePatchBody(rule),
        reason,
      });
    }
  }
  const highestBotRole = highestDiscordRole(
    snapshot.roles.filter((item) => (snapshot.bot.roles ?? []).includes(item.id)),
  );
  const preservedRoles = new Set([
    guildId,
    canaryRoleId,
    ...(snapshot.bot.roles ?? []),
    ...snapshot.roles.filter((role) => roleAtOrAbove(role, highestBotRole)).map((role) => role.id),
  ]);
  for (const role of snapshot.roles)
    if (!preservedRoles.has(role.id) && !role.managed)
      await mutate(rest, 'DELETE', `/guilds/${guildId}/roles/${role.id}`, { reason });
  const channels = snapshot.channels.filter((channel) => channel.id !== canaryChannelId);
  channels.sort((left, right) => Number(left.type === 4) - Number(right.type === 4));
  for (const channel of channels)
    await mutate(rest, 'DELETE', `/channels/${channel.id}`, { reason });
  snapshot = await readCanarySnapshot(readSnapshot, guildId, botId, canaryChannelId);
  assertSnapshot(snapshot, guildId, botId);
  validateCanary(snapshot, canaryRoleId, canaryChannelId, guildId);
  assertDisabledCommunityState(snapshot, guildId);
  const fingerprint = snapshotFingerprint(snapshot);
  if (typeof fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprint))
    throw new Error('baseline fingerprint is malformed');
  const baseline = baselineView(
    snapshot,
    guildId,
    botId,
    canaryRoleId,
    canaryChannelId,
    fingerprint,
    runId,
  );
  return cloneJson(baseline);
}
