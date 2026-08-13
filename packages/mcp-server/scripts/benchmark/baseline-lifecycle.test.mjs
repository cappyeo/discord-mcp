import { describe, expect, it } from 'vitest';
import { signBaselineArtifact } from './artifact-store.mjs';
import {
  initializeBenchmarkBaseline,
  restoreBenchmarkBaseline,
  verifyBenchmarkBaseline,
} from './baseline-lifecycle.mjs';
import { DiscordRestError } from './discord-rest.mjs';

const GUILD = '999000999000999000';
const BOT = '888000888000888000';
const BOT_ROLE = '888000888000999001';
const CANARY_ROLE = '777000777000999001';
const CANARY_CHANNEL = '777000777000999002';
const EXTRA_ROLE = '777000777000999003';
const EQUAL_POSITION_ABOVE_ROLE = '888000888000999000';
const EQUAL_POSITION_BELOW_ROLE = '888000888000999002';
const EXTRA_CATEGORY = '777000777000999004';
const EXTRA_CHANNEL = '777000777000999005';
const RULE = '777000777000999006';
const MESSAGE = '777000777000999007';
const PROTECTED_RULE = '777000777000999008';
const COMMUNITY_SETUP_MESSAGE = '777000777000999009';
const AUTOMOD_SETUP_MESSAGE = '777000777000999010';
const FOREIGN_BOT = '666000666000666666';
const FP = `sha256:${'a'.repeat(64)}`;
const INTEGRITY_KEY = 'benchmark-baseline-lifecycle-test-key';
const RESTORE_TARGET_GUARD = Object.freeze({
  allowedGuildIds: [GUILD],
  expectedBotId: BOT,
  confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
  integrityKey: INTEGRITY_KEY,
});

function baselineSnapshot() {
  return {
    guild: {
      id: GUILD,
      name: 'Benchmark guild',
      description: null,
      preferred_locale: 'en-US',
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      features: ['COMMUNITY'],
      rules_channel_id: CANARY_CHANNEL,
      public_updates_channel_id: CANARY_CHANNEL,
      safety_alerts_channel_id: CANARY_CHANNEL,
    },
    bot: { user: { id: BOT }, roles: [BOT_ROLE] },
    roles: [
      { id: GUILD, name: '@everyone', managed: false, permissions: '0', position: 0 },
      {
        id: CANARY_ROLE,
        name: '__discord_mcp_benchmark_canary_role__',
        managed: false,
        permissions: '0',
        position: 1,
      },
      { id: BOT_ROLE, name: 'DevBot', managed: true, permissions: '8', position: 2 },
    ],
    channels: [
      {
        id: CANARY_CHANNEL,
        guild_id: GUILD,
        name: '__discord_mcp_benchmark_canary_channel__',
        type: 0,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
    automod_rules: [],
    onboarding: {
      guild_id: GUILD,
      enabled: false,
      prompts: [],
      default_channel_ids: [],
      mode: 0,
    },
    welcome_screen: {
      welcome_channels: [],
      description: null,
    },
    recent_messages: {},
    publication_history_complete: { [CANARY_CHANNEL]: true },
  };
}

function mentionSpamRule({ creator_id = BOT, enabled = false } = {}) {
  return {
    id: PROTECTED_RULE,
    guild_id: GUILD,
    creator_id,
    name: 'Protected mention spam',
    event_type: 1,
    trigger_type: 5,
    trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
    actions: [{ type: 1 }],
    enabled,
    exempt_roles: [],
    exempt_channels: [],
  };
}

function makeUnsignedBaseline({ protectedRule = null } = {}) {
  const snapshot = baselineSnapshot();
  if (protectedRule) snapshot.automod_rules = [structuredClone(protectedRule)];
  return {
    schema_version: 1,
    kind: 'discord-mcp-benchmark-baseline',
    guild_id: GUILD,
    bot_id: BOT,
    fingerprint: FP,
    canary: { role_id: CANARY_ROLE, channel_id: CANARY_CHANNEL },
    guild_fields: {
      id: GUILD,
      name: 'Benchmark guild',
      description: null,
      preferred_locale: 'en-US',
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      rules_channel_id: CANARY_CHANNEL,
      public_updates_channel_id: CANARY_CHANNEL,
      safety_alerts_channel_id: CANARY_CHANNEL,
      features: ['COMMUNITY'],
    },
    preserved_role_ids: [BOT_ROLE, CANARY_ROLE, GUILD],
    baseline_snapshot: snapshot,
  };
}

function makeBaseline(options = {}) {
  return signBaselineArtifact(makeUnsignedBaseline(options), { integrityKey: INTEGRITY_KEY });
}

function currentSnapshot() {
  const value = baselineSnapshot();
  value.roles = [
    ...value.roles,
    { id: EXTRA_ROLE, name: 'Generated', managed: false, permissions: '0', position: 1 },
  ];
  value.channels = [
    ...value.channels,
    {
      id: EXTRA_CATEGORY,
      guild_id: GUILD,
      name: 'Generated category',
      type: 4,
      parent_id: null,
      permission_overwrites: [],
    },
    {
      id: EXTRA_CHANNEL,
      guild_id: GUILD,
      name: 'generated',
      type: 0,
      parent_id: EXTRA_CATEGORY,
      permission_overwrites: [],
    },
  ];
  value.automod_rules = [{ id: RULE, guild_id: GUILD }];
  value.recent_messages = {
    [EXTRA_CHANNEL]: [{ id: MESSAGE, channel_id: EXTRA_CHANNEL, author: { id: BOT } }],
  };
  value.publication_history_complete = {
    [CANARY_CHANNEL]: true,
    [EXTRA_CHANNEL]: true,
  };
  return value;
}

function dependencies(state, { drift = false } = {}) {
  return {
    integrityKey: INTEGRITY_KEY,
    async readSnapshot() {
      return structuredClone(state.snapshot);
    },
    snapshotFingerprint(snapshot) {
      if (drift) return `${FP.slice(0, -1)}b`;
      const generated =
        snapshot.roles.some((role) => role.id === EXTRA_ROLE) ||
        snapshot.channels.some((channel) => [EXTRA_CATEGORY, EXTRA_CHANNEL].includes(channel.id)) ||
        snapshot.automod_rules.some((rule) => rule.id === RULE) ||
        Object.values(snapshot.recent_messages).some((messages) => messages.length > 0);
      return generated ? 'sha256:generated' : FP;
    },
  };
}

function protectedInitializerHarness({ creator_id = BOT, deleteError }) {
  const state = { snapshot: baselineSnapshot() };
  state.snapshot.automod_rules = [mentionSpamRule({ creator_id, enabled: true })];
  const calls = [];
  const rest = {
    async request(method, path, options) {
      calls.push([method, path, options]);
      if (method === 'DELETE' && path.includes('/auto-moderation/rules/')) throw deleteError;
      if (method === 'PATCH' && path.includes('/auto-moderation/rules/')) {
        Object.assign(state.snapshot.automod_rules[0], options.body);
        return structuredClone(state.snapshot.automod_rules[0]);
      }
      if (method === 'PATCH' && path === `/guilds/${GUILD}`) {
        Object.assign(state.snapshot.guild, options.body);
        return structuredClone(state.snapshot.guild);
      }
      if (method === 'PUT' && path.endsWith('/onboarding')) {
        state.snapshot.onboarding = { guild_id: GUILD, ...options.body };
        return structuredClone(state.snapshot.onboarding);
      }
      if (method === 'PATCH' && path.endsWith('/welcome-screen')) {
        state.snapshot.welcome_screen = {
          description: options.body.description,
          welcome_channels: options.body.welcome_channels,
        };
        return structuredClone(state.snapshot.welcome_screen);
      }
      throw new Error(`unexpected mutation ${method} ${path}`);
    },
  };
  return { state, calls, rest };
}

function cleanInitializerHarness({ createResponse, persistCreatedRule = true } = {}) {
  const state = { snapshot: baselineSnapshot() };
  const calls = [];
  const rest = {
    async request(method, path, options) {
      calls.push([method, path, options]);
      if (method === 'PATCH' && path === `/guilds/${GUILD}`) {
        Object.assign(state.snapshot.guild, options.body);
        return structuredClone(state.snapshot.guild);
      }
      if (method === 'PUT' && path.endsWith('/onboarding')) {
        state.snapshot.onboarding = { guild_id: GUILD, ...options.body };
        return structuredClone(state.snapshot.onboarding);
      }
      if (method === 'PATCH' && path.endsWith('/welcome-screen')) {
        state.snapshot.welcome_screen = {
          description: options.body.description,
          welcome_channels: options.body.welcome_channels,
        };
        return structuredClone(state.snapshot.welcome_screen);
      }
      if (method === 'POST' && path.endsWith('/auto-moderation/rules')) {
        const rule = createResponse ?? {
          ...mentionSpamRule(),
          name: '__discord_mcp_benchmark_canary_mention_spam__',
        };
        if (persistCreatedRule) state.snapshot.automod_rules.push(structuredClone(rule));
        return structuredClone(rule);
      }
      throw new Error(`unexpected mutation ${method} ${path}`);
    },
  };
  return { state, calls, rest };
}

describe('benchmark baseline lifecycle', () => {
  it('rejects confirmation and allowlist errors before any REST mutation', async () => {
    const calls = [];
    const rest = { request: async (...args) => calls.push(args) };
    const readSnapshot = async () => baselineSnapshot();
    const snapshotFingerprint = () => FP;
    await expect(
      initializeBenchmarkBaseline({
        rest,
        readSnapshot,
        snapshotFingerprint,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: ['999000999000999001'],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'test',
      }),
    ).rejects.toThrow('allowlist');
    await expect(
      initializeBenchmarkBaseline({
        rest,
        readSnapshot,
        snapshotFingerprint,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: 'no',
        runId: 'test',
      }),
    ).rejects.toThrow('confirmation');
    expect(calls).toHaveLength(0);
  });

  it('rejects restore target guard failures before any read or REST mutation', async () => {
    const reads = [];
    const mutations = [];
    const common = {
      rest: { request: async (...args) => mutations.push(args) },
      async readSnapshot(...args) {
        reads.push(args);
        return baselineSnapshot();
      },
      snapshotFingerprint: () => FP,
      baseline: makeBaseline(),
      integrityKey: INTEGRITY_KEY,
      cleanup: null,
      reason: 'guard regression',
    };

    await expect(
      restoreBenchmarkBaseline({
        ...common,
        allowedGuildIds: ['999000999000999001'],
        expectedBotId: BOT,
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
      }),
    ).rejects.toThrow('allowlist');
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        allowedGuildIds: [GUILD],
        expectedBotId: FOREIGN_BOT,
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
      }),
    ).rejects.toThrow('expected bot');
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        allowedGuildIds: [GUILD],
        expectedBotId: BOT,
        confirmation: 'no',
      }),
    ).rejects.toThrow('confirmation');
    expect(reads).toHaveLength(0);
    expect(mutations).toHaveLength(0);
  });

  it.each([
    ['guild_fields', (baseline) => (baseline.guild_fields.name = 'tampered guild')],
    [
      'baseline_snapshot resources',
      (baseline) => (baseline.baseline_snapshot.channels[0].name = 'tampered channel'),
    ],
  ])('rejects tampered %s before any REST mutation', async (_label, tamper) => {
    const baseline = makeBaseline();
    tamper(baseline);
    const mutations = [];
    await expect(
      restoreBenchmarkBaseline({
        rest: { request: async (...args) => mutations.push(args) },
        readSnapshot: async () => baselineSnapshot(),
        snapshotFingerprint: () => FP,
        baseline,
        ...RESTORE_TARGET_GUARD,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
        reason: 'tamper regression',
        integrityKey: INTEGRITY_KEY,
      }),
    ).rejects.toThrow(/integrity/);
    expect(mutations).toHaveLength(0);
  });

  it('rejects an unsigned baseline before any REST mutation', async () => {
    const mutations = [];
    await expect(
      restoreBenchmarkBaseline({
        rest: { request: async (...args) => mutations.push(args) },
        readSnapshot: async () => baselineSnapshot(),
        snapshotFingerprint: () => FP,
        baseline: makeUnsignedBaseline(),
        ...RESTORE_TARGET_GUARD,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
        reason: 'unsigned baseline regression',
      }),
    ).rejects.toThrow(/integrity/);
    expect(mutations).toHaveLength(0);
  });

  it('classifies an unavailable preflight read without authorizing readback confirmation', async () => {
    const mutations = [];

    await expect(
      restoreBenchmarkBaseline({
        rest: { request: async (...args) => mutations.push(args) },
        async readSnapshot() {
          throw new DiscordRestError('temporary snapshot transport failure', {
            method: 'GET',
            path: `/guilds/${GUILD}`,
            disposition: 'ambiguous',
          });
        },
        snapshotFingerprint: () => FP,
        baseline: makeBaseline(),
        ...RESTORE_TARGET_GUARD,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
        reason: 'preflight classification regression',
      }),
    ).rejects.toMatchObject({
      code: 'RESTORE_PREFLIGHT_UNAVAILABLE',
      retryable: true,
      preflightVerified: false,
      readbackMayConfirm: false,
    });

    await expect(
      restoreBenchmarkBaseline({
        rest: { request: async (...args) => mutations.push(args) },
        async readSnapshot() {
          throw new DiscordRestError('Discord REST 403', {
            status: 403,
            method: 'GET',
            path: `/guilds/${GUILD}`,
            disposition: 'deterministic',
          });
        },
        snapshotFingerprint: () => FP,
        baseline: makeBaseline(),
        ...RESTORE_TARGET_GUARD,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
        reason: 'preflight deterministic regression',
      }),
    ).rejects.toMatchObject({
      code: 'RESTORE_SAFETY_VIOLATION',
      retryable: false,
      preflightVerified: false,
      readbackMayConfirm: false,
    });
    expect(mutations).toHaveLength(0);
  });

  it.each([
    { currentVerificationLevel: 0, expectedVerificationLevel: 1 },
    { currentVerificationLevel: 3, expectedVerificationLevel: 3 },
  ])('initializes a non-Community disposable guild at verification level $currentVerificationLevel before deleting referenced resources', async ({
    currentVerificationLevel,
    expectedVerificationLevel,
  }) => {
    const state = { snapshot: currentSnapshot() };
    state.snapshot.guild.verification_level = currentVerificationLevel;
    state.snapshot.roles.push(
      {
        id: EQUAL_POSITION_ABOVE_ROLE,
        name: 'Equal position above bot',
        managed: false,
        permissions: '0',
        position: 2,
      },
      {
        id: EQUAL_POSITION_BELOW_ROLE,
        name: 'Equal position below bot',
        managed: false,
        permissions: '0',
        position: 2,
      },
    );
    state.snapshot.guild.features = [];
    state.snapshot.guild.rules_channel_id = EXTRA_CHANNEL;
    state.snapshot.guild.public_updates_channel_id = EXTRA_CHANNEL;
    state.snapshot.guild.safety_alerts_channel_id = EXTRA_CHANNEL;
    state.snapshot.roles = state.snapshot.roles.filter((role) => role.id !== CANARY_ROLE);
    state.snapshot.channels = state.snapshot.channels.filter(
      (channel) => channel.id !== CANARY_CHANNEL,
    );
    state.snapshot.onboarding = null;
    state.snapshot.welcome_screen = null;
    state.snapshot.recent_messages = {};
    state.snapshot.publication_history_complete = {};
    const calls = [];
    const readSnapshot = async ({ messageChannelIds = [] }) => {
      const value = structuredClone(state.snapshot);
      value.recent_messages = Object.fromEntries(
        messageChannelIds.map((id) => [
          id,
          structuredClone(state.snapshot.recent_messages[id] ?? []),
        ]),
      );
      value.publication_history_complete = Object.fromEntries(
        messageChannelIds.map((id) => [id, true]),
      );
      return value;
    };
    const rest = {
      async request(method, path, options) {
        calls.push([method, path, options]);
        if (method === 'POST' && path.endsWith('/roles')) {
          const role = {
            id: CANARY_ROLE,
            name: '__discord_mcp_benchmark_canary_role__',
            managed: false,
            permissions: '0',
            position: 2,
          };
          state.snapshot.roles.push(role);
          return role;
        }
        if (method === 'POST' && path.endsWith('/channels')) {
          const channel = {
            id: CANARY_CHANNEL,
            guild_id: GUILD,
            name: '__discord_mcp_benchmark_canary_channel__',
            type: 0,
            position: 0,
            parent_id: null,
            permission_overwrites: [],
          };
          state.snapshot.channels.push(channel);
          return channel;
        }
        if (method === 'POST' && path.endsWith('/auto-moderation/rules')) {
          const rule = {
            ...mentionSpamRule(),
            name: '__discord_mcp_benchmark_canary_mention_spam__',
          };
          state.snapshot.automod_rules.push(rule);
          return structuredClone(rule);
        }
        if (method === 'PATCH' && path === `/guilds/${GUILD}`) {
          Object.assign(state.snapshot.guild, options.body);
          state.snapshot.recent_messages[CANARY_CHANNEL] = [
            {
              id: COMMUNITY_SETUP_MESSAGE,
              guild_id: GUILD,
              channel_id: CANARY_CHANNEL,
              type: 0,
              author: { id: '669627189624307712', bot: true },
            },
            {
              id: AUTOMOD_SETUP_MESSAGE,
              guild_id: GUILD,
              channel_id: CANARY_CHANNEL,
              type: 24,
              author: { id: '1008776202191634432', bot: true },
            },
          ];
          state.snapshot.onboarding = {
            guild_id: GUILD,
            enabled: false,
            prompts: [],
            default_channel_ids: [],
            mode: 0,
          };
          state.snapshot.welcome_screen = { description: null, welcome_channels: [] };
          return structuredClone(state.snapshot.guild);
        }
        if (method === 'PUT' && path.endsWith('/onboarding')) {
          state.snapshot.onboarding = { guild_id: GUILD, ...options.body };
          return structuredClone(state.snapshot.onboarding);
        }
        if (method === 'PATCH' && path.endsWith('/welcome-screen')) {
          state.snapshot.welcome_screen = {
            description: options.body.description,
            welcome_channels: options.body.welcome_channels,
          };
          state.snapshot.guild.features = state.snapshot.guild.features.filter(
            (feature) => feature !== 'WELCOME_SCREEN_ENABLED',
          );
          return structuredClone(state.snapshot.welcome_screen);
        }
        if (method === 'DELETE' && path.includes('/auto-moderation/rules/')) {
          state.snapshot.automod_rules = [];
          return null;
        }
        if (method === 'DELETE' && path.includes('/messages/')) {
          const id = path.split('/').at(-1);
          state.snapshot.recent_messages[CANARY_CHANNEL] = (
            state.snapshot.recent_messages[CANARY_CHANNEL] ?? []
          ).filter((message) => message.id !== id);
          return null;
        }
        if (method === 'DELETE' && path.includes('/roles/')) {
          const id = path.split('/').at(-1);
          state.snapshot.roles = state.snapshot.roles.filter((role) => role.id !== id);
          return null;
        }
        if (method === 'DELETE' && path.startsWith('/channels/')) {
          const id = path.split('/').at(-1);
          state.snapshot.channels = state.snapshot.channels.filter((channel) => channel.id !== id);
          return null;
        }
        throw new Error(`unexpected mutation ${method} ${path}`);
      },
    };

    const baseline = await initializeBenchmarkBaseline({
      rest,
      readSnapshot,
      snapshotFingerprint: () => FP,
      guildId: GUILD,
      botId: BOT,
      allowedGuildIds: [GUILD],
      confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
      runId: 'initializer-test',
    });

    expect(baseline.fingerprint).toBe(FP);
    expect(baseline.run_id).toBe('initializer-test');
    expect(baseline.guild_fields.features).toContain('COMMUNITY');
    expect(baseline.baseline_snapshot.automod_rules).toEqual([
      expect.objectContaining({ id: PROTECTED_RULE, creator_id: BOT, enabled: false }),
    ]);
    expect(state.snapshot.channels.map((channel) => channel.id)).toEqual([CANARY_CHANNEL]);
    expect(state.snapshot.roles.some((role) => role.id === EXTRA_ROLE)).toBe(false);
    expect(state.snapshot.roles.some((role) => role.id === EQUAL_POSITION_ABOVE_ROLE)).toBe(true);
    expect(state.snapshot.roles.some((role) => role.id === EQUAL_POSITION_BELOW_ROLE)).toBe(false);
    expect(baseline.preserved_role_ids).toContain(EQUAL_POSITION_ABOVE_ROLE);
    expect(baseline.preserved_role_ids).not.toContain(EQUAL_POSITION_BELOW_ROLE);
    const guildPatch = calls.findIndex(
      ([method, path]) => method === 'PATCH' && path === `/guilds/${GUILD}`,
    );
    expect(calls[guildPatch]?.[2].body).toMatchObject({
      verification_level: expectedVerificationLevel,
      default_message_notifications: 1,
      explicit_content_filter: 2,
    });
    const firstChannelDelete = calls.findIndex(
      ([method, path]) => method === 'DELETE' && path.startsWith('/channels/'),
    );
    expect(guildPatch).toBeGreaterThan(-1);
    expect(guildPatch).toBeLessThan(firstChannelDelete);
    expect(
      calls
        .filter(([method, path]) => method === 'DELETE' && path.includes('/messages/'))
        .map(([, path]) => path),
    ).toEqual([
      `/channels/${CANARY_CHANNEL}/messages/${COMMUNITY_SETUP_MESSAGE}`,
      `/channels/${CANARY_CHANNEL}/messages/${AUTOMOD_SETUP_MESSAGE}`,
    ]);
    expect(
      calls.find(([method, path]) => method === 'PUT' && path.endsWith('/onboarding')),
    ).toBeTruthy();
    expect(
      calls.find(([method, path]) => method === 'PATCH' && path.endsWith('/welcome-screen')),
    ).toBeTruthy();
    expect(
      calls.every(([method, , options]) =>
        method === 'POST' ? options.retry === false : options.retry === undefined,
      ),
    ).toBe(true);
  });

  it('fails closed instead of deleting a non-system canary message', async () => {
    const snapshot = baselineSnapshot();
    snapshot.recent_messages[CANARY_CHANNEL] = [
      {
        id: MESSAGE,
        guild_id: GUILD,
        channel_id: CANARY_CHANNEL,
        type: 0,
        author: { id: BOT, bot: true },
      },
    ];
    const calls = [];

    await expect(
      initializeBenchmarkBaseline({
        rest: { request: async (...args) => calls.push(args) },
        readSnapshot: async () => structuredClone(snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'unexpected-canary-message',
      }),
    ).rejects.toThrow('non-Discord-system message');
    expect(calls).toHaveLength(0);
  });

  it('fails closed and preserves manageable roles when no bot hierarchy anchor exists', async () => {
    const state = { snapshot: baselineSnapshot() };
    state.snapshot.bot.roles = [];
    state.snapshot.roles.push({
      id: EXTRA_ROLE,
      name: 'Unanchored role',
      managed: false,
      permissions: '0',
      position: 1,
    });
    const calls = [];
    const rest = {
      async request(method, path, options) {
        calls.push([method, path, options]);
        if (method === 'PATCH' && path === `/guilds/${GUILD}`) {
          Object.assign(state.snapshot.guild, options.body);
          return structuredClone(state.snapshot.guild);
        }
        if (method === 'PUT' && path.endsWith('/onboarding')) {
          state.snapshot.onboarding = { guild_id: GUILD, ...options.body };
          return structuredClone(state.snapshot.onboarding);
        }
        if (method === 'PATCH' && path.endsWith('/welcome-screen')) {
          state.snapshot.welcome_screen = {
            description: options.body.description,
            welcome_channels: options.body.welcome_channels,
          };
          return structuredClone(state.snapshot.welcome_screen);
        }
        if (method === 'POST' && path.endsWith('/auto-moderation/rules')) {
          const rule = {
            ...mentionSpamRule(),
            name: '__discord_mcp_benchmark_canary_mention_spam__',
          };
          state.snapshot.automod_rules.push(rule);
          return structuredClone(rule);
        }
        throw new Error(`unexpected mutation ${method} ${path}`);
      },
    };

    const baseline = await initializeBenchmarkBaseline({
      rest,
      readSnapshot: async () => structuredClone(state.snapshot),
      snapshotFingerprint: () => FP,
      guildId: GUILD,
      botId: BOT,
      allowedGuildIds: [GUILD],
      confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
      runId: 'unanchored-hierarchy',
    });

    expect(state.snapshot.roles.some((role) => role.id === EXTRA_ROLE)).toBe(true);
    expect(baseline.preserved_role_ids).toContain(EXTRA_ROLE);
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  it('preserves a bot-owned protected mention-spam rule after delete code 200006', async () => {
    const harness = protectedInitializerHarness({
      deleteError: Object.assign(new Error('Discord REST 400 code 200006: protected rule'), {
        code: 200006,
      }),
    });
    const baseline = await initializeBenchmarkBaseline({
      rest: harness.rest,
      readSnapshot: async () => structuredClone(harness.state.snapshot),
      snapshotFingerprint: () => FP,
      guildId: GUILD,
      botId: BOT,
      allowedGuildIds: [GUILD],
      confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
      runId: 'protected-rule',
    });
    const rule = baseline.baseline_snapshot.automod_rules[0];
    expect(rule).toMatchObject({
      id: PROTECTED_RULE,
      creator_id: BOT,
      trigger_type: 5,
      enabled: false,
      actions: [{ type: 1 }],
      exempt_roles: [],
      exempt_channels: [],
      trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
    });
    expect(
      harness.calls.some(
        ([method, path]) =>
          method === 'DELETE' && path.endsWith(`/auto-moderation/rules/${PROTECTED_RULE}`),
      ),
    ).toBe(true);
    expect(
      harness.calls.some(
        ([method, path]) => method === 'POST' && path.endsWith('/auto-moderation/rules'),
      ),
    ).toBe(false);
    const patch = harness.calls.find(
      ([method, path]) =>
        method === 'PATCH' && path.endsWith(`/auto-moderation/rules/${PROTECTED_RULE}`),
    );
    expect(patch?.[2]?.body).toEqual({
      name: 'Protected mention spam',
      event_type: 1,
      trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
      actions: [{ type: 1 }],
      enabled: false,
      exempt_roles: [],
      exempt_channels: [],
    });
  });

  it('fails closed when the protected mention-spam create response is malformed', async () => {
    const harness = cleanInitializerHarness({
      createResponse: {
        ...mentionSpamRule({ creator_id: FOREIGN_BOT }),
        name: '__discord_mcp_benchmark_canary_mention_spam__',
      },
      persistCreatedRule: false,
    });

    await expect(
      initializeBenchmarkBaseline({
        rest: harness.rest,
        readSnapshot: async () => structuredClone(harness.state.snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'malformed-protected-create',
      }),
    ).rejects.toThrow('protected mention-spam canary response is malformed');
    expect(
      harness.calls.filter(
        ([method, path]) => method === 'POST' && path.endsWith('/auto-moderation/rules'),
      ),
    ).toHaveLength(1);
  });

  it('fails closed when final readback cannot find the protected mention-spam canary', async () => {
    const harness = cleanInitializerHarness({ persistCreatedRule: false });

    await expect(
      initializeBenchmarkBaseline({
        rest: harness.rest,
        readSnapshot: async () => structuredClone(harness.state.snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'missing-protected-readback',
      }),
    ).rejects.toThrow('baseline protected mention-spam canary is missing');
    expect(harness.calls.some(([method]) => method === 'DELETE')).toBe(false);
  });

  it('fails closed before mutation for a foreign protected mention-spam rule', async () => {
    const harness = protectedInitializerHarness({
      creator_id: FOREIGN_BOT,
      deleteError: Object.assign(new Error('Discord REST 400 code 200006'), { code: 200006 }),
    });
    await expect(
      initializeBenchmarkBaseline({
        rest: harness.rest,
        readSnapshot: async () => structuredClone(harness.state.snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'foreign-protected-rule',
      }),
    ).rejects.toThrow('foreign protected mention-spam rule');
    expect(harness.calls).toHaveLength(0);
  });

  it('fails closed before mutation for multiple bot-owned protected mention-spam rules', async () => {
    const snapshot = baselineSnapshot();
    snapshot.automod_rules = [
      mentionSpamRule(),
      { ...mentionSpamRule(), id: '777000777000999011' },
    ];
    const calls = [];

    await expect(
      initializeBenchmarkBaseline({
        rest: { request: async (...args) => calls.push(args) },
        readSnapshot: async () => structuredClone(snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'multiple-protected-rules',
      }),
    ).rejects.toThrow('multiple bot-owned protected mention-spam rules');
    expect(calls).toHaveLength(0);
  });

  it('fails closed for any AutoMod delete error other than code 200006', async () => {
    const harness = protectedInitializerHarness({
      deleteError: Object.assign(new Error('Discord REST 500 code 200001'), { code: 200001 }),
    });
    await expect(
      initializeBenchmarkBaseline({
        rest: harness.rest,
        readSnapshot: async () => structuredClone(harness.state.snapshot),
        snapshotFingerprint: () => FP,
        guildId: GUILD,
        botId: BOT,
        allowedGuildIds: [GUILD],
        confirmation: `RESET_DISPOSABLE_GUILD:${GUILD}`,
        runId: 'other-error',
      }),
    ).rejects.toThrow('200001');
  });

  it('verifies the exact baseline fingerprint and detects drift', async () => {
    const baseline = makeBaseline();
    const state = { snapshot: baselineSnapshot() };
    const deps = dependencies(state);
    await expect(verifyBenchmarkBaseline({ ...deps, baseline })).resolves.toMatchObject({
      verified: true,
      fingerprint: FP,
    });
    await expect(
      verifyBenchmarkBaseline({ ...dependencies(state, { drift: true }), baseline }),
    ).rejects.toThrow('BASELINE_FINGERPRINT_DRIFT');
  });

  it('rejects a canary channel with permission overwrites', async () => {
    const baseline = makeUnsignedBaseline();
    baseline.baseline_snapshot.channels[0].permission_overwrites = [
      { id: GUILD, type: 0, allow: '0', deny: '0' },
    ];
    const signedBaseline = signBaselineArtifact(baseline, { integrityKey: INTEGRITY_KEY });

    await expect(
      verifyBenchmarkBaseline({
        ...dependencies({ snapshot: baselineSnapshot() }),
        baseline: signedBaseline,
      }),
    ).rejects.toThrow(/canary channel.*unsafe/);
  });

  it('restores only frozen bindings in child-before-category order', async () => {
    const state = { snapshot: currentSnapshot() };
    const calls = [];
    const rest = {
      async request(method, path, options) {
        calls.push([method, path, options]);
        if (path.includes(`/channels/${EXTRA_CHANNEL}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CHANNEL,
          );
        if (path.includes(`/channels/${EXTRA_CATEGORY}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CATEGORY,
          );
        if (path.includes(`/roles/${EXTRA_ROLE}`) && method === 'DELETE')
          state.snapshot.roles = state.snapshot.roles.filter((item) => item.id !== EXTRA_ROLE);
        if (path.includes(`/auto-moderation/rules/${RULE}`)) state.snapshot.automod_rules = [];
        if (path.includes(`/messages/${MESSAGE}`)) state.snapshot.recent_messages = {};
        if (path === `/guilds/${GUILD}`) return structuredClone(state.snapshot.guild);
        if (path.endsWith('/onboarding')) return structuredClone(state.snapshot.onboarding);
        if (path.endsWith('/welcome-screen')) return structuredClone(state.snapshot.welcome_screen);
        return null;
      },
    };
    const restoreInput = {
      rest,
      ...dependencies(state),
      baseline: makeBaseline(),
      ...RESTORE_TARGET_GUARD,
      cleanup: {
        guild_id: GUILD,
        bot_id: BOT,
        publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
        bindings: {
          roles: { member: EXTRA_ROLE },
          categories: { generated: EXTRA_CATEGORY },
          channels: { generated: EXTRA_CHANNEL },
          automod_rules: { spam: RULE },
          publications: { welcome: MESSAGE },
        },
      },
      reason: 'benchmark restore',
    };
    const result = await restoreBenchmarkBaseline(restoreInput);
    expect(result.restored).toBe(true);
    const deletes = calls.filter(([method]) => method === 'DELETE').map(([, path]) => path);
    expect(deletes.indexOf(`/channels/${EXTRA_CHANNEL}`)).toBeLessThan(
      deletes.indexOf(`/channels/${EXTRA_CATEGORY}`),
    );
    expect(deletes).toContain(`/channels/${EXTRA_CHANNEL}/messages/${MESSAGE}`);
    const onboarding = calls.find(([, path]) => path.endsWith('/onboarding'));
    const welcome = calls.find(([, path]) => path.endsWith('/welcome-screen'));
    expect(onboarding?.[0]).toBe('PUT');
    expect(onboarding?.[2]?.body).toEqual({
      prompts: [],
      default_channel_ids: [],
      enabled: false,
      mode: 0,
    });
    expect(welcome?.[0]).toBe('PATCH');
    expect(welcome?.[2]?.body).toEqual({
      enabled: false,
      welcome_channels: [],
      description: null,
    });
    expect(calls.findIndex(([, path]) => path === `/guilds/${GUILD}`)).toBeLessThan(
      calls.findIndex(([, path]) => path === `/channels/${EXTRA_CHANNEL}`),
    );

    const callCountBeforeWrongBaseline = calls.length;
    await expect(
      restoreBenchmarkBaseline({
        ...restoreInput,
        baseline: { ...restoreInput.baseline, fingerprint: `sha256:${'b'.repeat(64)}` },
        retryProof: result.retryProof,
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_SAFETY_VIOLATION' });
    expect(calls).toHaveLength(callCountBeforeWrongBaseline);

    const replay = await restoreBenchmarkBaseline({
      ...restoreInput,
      retryProof: result.retryProof,
    });
    expect(replay).toMatchObject({
      restored: true,
      fingerprint: FP,
      deleted: { messages: 0, automod_rules: 0, channels: 0, roles: 0 },
    });
  });

  it('resumes cleanup when some frozen bindings were already deleted', async () => {
    const state = { snapshot: currentSnapshot() };
    let failCategoryDelete = true;
    const calls = [];
    const rest = {
      async request(method, path) {
        calls.push([method, path]);
        if (method === 'DELETE' && path.includes(`/messages/${MESSAGE}`)) {
          state.snapshot.recent_messages = {};
          return null;
        }
        if (method === 'DELETE' && path.includes(`/auto-moderation/rules/${RULE}`)) {
          state.snapshot.automod_rules = [];
          return null;
        }
        if (method === 'DELETE' && path === `/channels/${EXTRA_CHANNEL}`) {
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CHANNEL,
          );
          return null;
        }
        if (method === 'DELETE' && path === `/channels/${EXTRA_CATEGORY}`) {
          if (failCategoryDelete) throw new Error('transport closed during category delete');
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CATEGORY,
          );
          return null;
        }
        if (method === 'DELETE' && path.endsWith(`/roles/${EXTRA_ROLE}`)) {
          state.snapshot.roles = state.snapshot.roles.filter((item) => item.id !== EXTRA_ROLE);
          return null;
        }
        if (path === `/guilds/${GUILD}`) return structuredClone(state.snapshot.guild);
        if (path.endsWith('/onboarding')) return structuredClone(state.snapshot.onboarding);
        if (path.endsWith('/welcome-screen')) return structuredClone(state.snapshot.welcome_screen);
        return null;
      },
    };

    const partialRestore = {
      rest,
      ...dependencies(state),
      baseline: makeBaseline(),
      ...RESTORE_TARGET_GUARD,
      cleanup: {
        guild_id: GUILD,
        bot_id: BOT,
        publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
        bindings: {
          roles: { member: EXTRA_ROLE },
          categories: { generated: EXTRA_CATEGORY },
          channels: { generated: EXTRA_CHANNEL },
          automod_rules: { spam: RULE },
          publications: { welcome: MESSAGE },
        },
      },
      reason: 'partial restore resume',
    };

    await expect(
      restoreBenchmarkBaseline({ ...partialRestore, retryProof: Object.freeze({}) }),
    ).rejects.toMatchObject({ code: 'RESTORE_SAFETY_VIOLATION' });
    expect(calls).toHaveLength(0);

    let firstFailure;
    try {
      await restoreBenchmarkBaseline(partialRestore);
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      code: 'RESTORE_EXECUTION_AMBIGUOUS',
      retryable: true,
      preflightVerified: true,
      retryProof: expect.any(Object),
    });
    expect(state.snapshot.roles.some((item) => item.id === EXTRA_ROLE)).toBe(true);
    expect(state.snapshot.channels.some((item) => item.id === EXTRA_CATEGORY)).toBe(true);
    expect(state.snapshot.channels.some((item) => item.id === EXTRA_CHANNEL)).toBe(false);
    expect(state.snapshot.automod_rules).toEqual([]);
    expect(state.snapshot.recent_messages).toEqual({});

    const retryCallStart = calls.length;
    failCategoryDelete = false;
    const result = await restoreBenchmarkBaseline({
      ...partialRestore,
      retryProof: firstFailure.retryProof,
    });

    expect(result).toMatchObject({
      restored: true,
      fingerprint: FP,
      deleted: { messages: 0, automod_rules: 0, channels: 1, roles: 1 },
    });
    const retryDeletes = calls
      .slice(retryCallStart)
      .filter(([method]) => method === 'DELETE')
      .map(([, path]) => path);
    expect(retryDeletes).toEqual([
      `/channels/${EXTRA_CATEGORY}`,
      `/guilds/${GUILD}/roles/${EXTRA_ROLE}`,
    ]);
  });

  it('patches a bound bot-owned protected baseline rule and deletes generated AutoMod rules', async () => {
    const state = { snapshot: currentSnapshot() };
    state.snapshot.automod_rules = [
      {
        ...mentionSpamRule({ enabled: true }),
        actions: [{ type: 2, metadata: { channel_id: CANARY_CHANNEL } }],
        exempt_roles: [BOT_ROLE],
      },
      ...state.snapshot.automod_rules,
    ];
    const calls = [];
    const rest = {
      async request(method, path, options) {
        calls.push([method, path, options]);
        if (method === 'PATCH' && path.endsWith(`/auto-moderation/rules/${PROTECTED_RULE}`)) {
          const rule = state.snapshot.automod_rules.find((item) => item.id === PROTECTED_RULE);
          Object.assign(rule, options.body);
          return structuredClone(rule);
        }
        if (path.includes(`/channels/${EXTRA_CHANNEL}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CHANNEL,
          );
        if (path.includes(`/channels/${EXTRA_CATEGORY}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CATEGORY,
          );
        if (path.includes(`/roles/${EXTRA_ROLE}`) && method === 'DELETE')
          state.snapshot.roles = state.snapshot.roles.filter((item) => item.id !== EXTRA_ROLE);
        if (path.includes(`/auto-moderation/rules/${RULE}`))
          state.snapshot.automod_rules = [
            ...state.snapshot.automod_rules.filter((item) => item.id !== RULE),
          ];
        if (path.includes(`/messages/${MESSAGE}`)) state.snapshot.recent_messages = {};
        if (path === `/guilds/${GUILD}`) return structuredClone(state.snapshot.guild);
        if (path.endsWith('/onboarding')) return structuredClone(state.snapshot.onboarding);
        if (path.endsWith('/welcome-screen')) return structuredClone(state.snapshot.welcome_screen);
        return null;
      },
    };
    const result = await restoreBenchmarkBaseline({
      rest,
      ...dependencies(state),
      baseline: makeBaseline({ protectedRule: mentionSpamRule() }),
      ...RESTORE_TARGET_GUARD,
      cleanup: {
        guild_id: GUILD,
        bot_id: BOT,
        publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
        bindings: {
          roles: { member: EXTRA_ROLE },
          categories: { generated: EXTRA_CATEGORY },
          channels: { generated: EXTRA_CHANNEL },
          automod_rules: { protected: PROTECTED_RULE, generated: RULE },
          publications: { welcome: MESSAGE },
        },
      },
      reason: 'protected restore',
    });
    expect(result.restored).toBe(true);
    expect(result.deleted.automod_rules).toBe(1);
    expect(
      calls.some(
        ([method, path]) =>
          method === 'DELETE' && path.endsWith(`/auto-moderation/rules/${PROTECTED_RULE}`),
      ),
    ).toBe(false);
    expect(
      calls.some(
        ([method, path]) => method === 'DELETE' && path.endsWith(`/auto-moderation/rules/${RULE}`),
      ),
    ).toBe(true);
    const patch = calls.find(
      ([method, path]) =>
        method === 'PATCH' && path.endsWith(`/auto-moderation/rules/${PROTECTED_RULE}`),
    );
    expect(patch?.[2]?.body).toEqual({
      name: 'Protected mention spam',
      event_type: 1,
      trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
      actions: [{ type: 1 }],
      enabled: false,
      exempt_roles: [],
      exempt_channels: [],
    });
  });

  it('classifies a deterministic Discord 403 after preflight as non-retryable', async () => {
    const state = { snapshot: currentSnapshot() };
    const calls = [];
    const rest = {
      async request(method, path) {
        calls.push([method, path]);
        throw new DiscordRestError('Discord REST 403', {
          status: 403,
          method,
          path,
          disposition: 'deterministic',
        });
      },
    };

    await expect(
      restoreBenchmarkBaseline({
        rest,
        ...dependencies(state),
        baseline: makeBaseline(),
        ...RESTORE_TARGET_GUARD,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
          bindings: {
            roles: { member: EXTRA_ROLE },
            categories: { generated: EXTRA_CATEGORY },
            channels: { generated: EXTRA_CHANNEL },
            automod_rules: { spam: RULE },
            publications: { welcome: MESSAGE },
          },
        },
        reason: 'deterministic REST rejection',
      }),
    ).rejects.toMatchObject({
      code: 'RESTORE_EXECUTION_REJECTED',
      retryable: false,
      preflightVerified: true,
      readbackMayConfirm: false,
      retryProof: expect.any(Object),
    });
    expect(calls).toEqual([['PUT', `/guilds/${GUILD}/onboarding`]]);
  });

  it('waits within a bounded schedule for restored Discord state to converge', async () => {
    const state = { snapshot: currentSnapshot() };
    const sleeps = [];
    let fingerprintCalls = 0;
    const rest = {
      async request(method, path) {
        if (path.includes(`/channels/${EXTRA_CHANNEL}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CHANNEL,
          );
        if (path.includes(`/channels/${EXTRA_CATEGORY}`) && method === 'DELETE')
          state.snapshot.channels = state.snapshot.channels.filter(
            (item) => item.id !== EXTRA_CATEGORY,
          );
        if (path.includes(`/roles/${EXTRA_ROLE}`) && method === 'DELETE')
          state.snapshot.roles = state.snapshot.roles.filter((item) => item.id !== EXTRA_ROLE);
        if (path.includes(`/auto-moderation/rules/${RULE}`)) state.snapshot.automod_rules = [];
        if (path.includes(`/messages/${MESSAGE}`)) state.snapshot.recent_messages = {};
        if (path === `/guilds/${GUILD}`) return structuredClone(state.snapshot.guild);
        if (path.endsWith('/onboarding')) return structuredClone(state.snapshot.onboarding);
        if (path.endsWith('/welcome-screen')) return structuredClone(state.snapshot.welcome_screen);
        return null;
      },
    };

    const result = await restoreBenchmarkBaseline({
      rest,
      readSnapshot: dependencies(state).readSnapshot,
      snapshotFingerprint() {
        fingerprintCalls += 1;
        return fingerprintCalls === 1 ? 'sha256:not-settled' : FP;
      },
      baseline: makeBaseline(),
      ...RESTORE_TARGET_GUARD,
      cleanup: {
        guild_id: GUILD,
        bot_id: BOT,
        bindings: {
          roles: { member: EXTRA_ROLE },
          categories: { generated: EXTRA_CATEGORY },
          channels: { generated: EXTRA_CHANNEL },
          automod_rules: { spam: RULE },
          publications: { welcome: MESSAGE },
        },
        publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
      },
      reason: 'test convergence',
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
      },
    });

    expect(result.restored).toBe(true);
    expect(sleeps).toEqual([250]);
  });

  it('rejects foreign, duplicate, canary, and orphan bindings without mutation', async () => {
    const state = { snapshot: currentSnapshot() };
    const calls = [];
    const rest = { request: async (...args) => calls.push(args) };
    const common = {
      rest,
      ...dependencies(state),
      baseline: makeBaseline(),
      ...RESTORE_TARGET_GUARD,
      reason: 'test',
    };
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
          guild_id: '999000999000999001',
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
      }),
    ).rejects.toThrow('exact baseline target');
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
          bindings: {
            roles: {},
            categories: {},
            channels: {},
            automod_rules: {},
            publications: { welcome: MESSAGE },
          },
        },
      }),
    ).rejects.toThrow('not a cleanup channel binding');
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: { a: EXTRA_ROLE, b: EXTRA_ROLE },
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
      }),
    ).rejects.toThrow('duplicate');
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          publication_targets: [],
          bindings: {
            roles: { a: CANARY_ROLE },
            categories: {},
            channels: {},
            automod_rules: {},
            publications: {},
          },
        },
      }),
    ).rejects.toThrow('baseline');
    state.snapshot.channels.push({
      id: '777000777000999008',
      guild_id: GUILD,
      name: 'orphan',
      type: 0,
      parent_id: null,
      permission_overwrites: [],
    });
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
          guild_id: GUILD,
          bot_id: BOT,
          bindings: {
            roles: { a: EXTRA_ROLE },
            categories: { generated: EXTRA_CATEGORY },
            channels: { generated: EXTRA_CHANNEL },
            automod_rules: { spam: RULE },
            publications: { welcome: MESSAGE },
          },
          publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
        },
      }),
    ).rejects.toThrow('ORPHAN');
    expect(calls).toHaveLength(0);
  });

  it('fails closed when the restored fingerprint drifts', async () => {
    const state = { snapshot: currentSnapshot() };
    const rest = {
      request: async (_method, path) => {
        if (path === `/guilds/${GUILD}`) return structuredClone(state.snapshot.guild);
        if (path.endsWith('/onboarding')) return structuredClone(state.snapshot.onboarding);
        if (path.endsWith('/welcome-screen')) return structuredClone(state.snapshot.welcome_screen);
        return null;
      },
    };
    const restoreInput = {
      rest,
      readSnapshot: dependencies(state).readSnapshot,
      sleep: async () => undefined,
      baseline: makeBaseline(),
      ...RESTORE_TARGET_GUARD,
      cleanup: {
        guild_id: GUILD,
        bot_id: BOT,
        bindings: {
          roles: { member: EXTRA_ROLE },
          categories: { generated: EXTRA_CATEGORY },
          channels: { generated: EXTRA_CHANNEL },
          automod_rules: { spam: RULE },
          publications: { welcome: MESSAGE },
        },
        publication_targets: [{ channel_id: EXTRA_CHANNEL, message_id: MESSAGE }],
      },
      reason: 'test',
    };
    await expect(
      restoreBenchmarkBaseline({
        ...restoreInput,
        snapshotFingerprint: dependencies(state, { drift: true }).snapshotFingerprint,
      }),
    ).rejects.toMatchObject({
      code: 'RESTORE_EXECUTION_AMBIGUOUS',
      retryable: true,
      preflightVerified: true,
      readbackMayConfirm: true,
      cause: expect.objectContaining({
        message: 'BASELINE_RESTORE_QUARANTINE_FINGERPRINT_DRIFT',
      }),
    });

    await expect(
      restoreBenchmarkBaseline({
        ...restoreInput,
        snapshotFingerprint() {
          throw new Error('snapshot fingerprint validation failed');
        },
      }),
    ).rejects.toMatchObject({
      code: 'RESTORE_SAFETY_VIOLATION',
      retryable: false,
      readbackMayConfirm: false,
      cause: expect.objectContaining({ message: 'snapshot fingerprint validation failed' }),
    });
  });
});
