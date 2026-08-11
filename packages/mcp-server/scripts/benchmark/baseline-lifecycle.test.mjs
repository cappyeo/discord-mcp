import { describe, expect, it } from 'vitest';
import {
  initializeBenchmarkBaseline,
  restoreBenchmarkBaseline,
  verifyBenchmarkBaseline,
} from './baseline-lifecycle.mjs';

const GUILD = '999000999000999000';
const BOT = '888000888000888000';
const BOT_ROLE = '888000888000999001';
const CANARY_ROLE = '777000777000999001';
const CANARY_CHANNEL = '777000777000999002';
const EXTRA_ROLE = '777000777000999003';
const EXTRA_CATEGORY = '777000777000999004';
const EXTRA_CHANNEL = '777000777000999005';
const RULE = '777000777000999006';
const MESSAGE = '777000777000999007';
const FP = `sha256:${'a'.repeat(64)}`;

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

function makeBaseline() {
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
    baseline_snapshot: baselineSnapshot(),
  };
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
    async readSnapshot() {
      return structuredClone(state.snapshot);
    },
    snapshotFingerprint(snapshot) {
      if (drift) return `${FP.slice(0, -1)}b`;
      return snapshot.roles.some((role) => role.id === EXTRA_ROLE) ? 'sha256:generated' : FP;
    },
  };
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

  it('initializes a non-Community disposable guild before deleting referenced resources', async () => {
    const state = { snapshot: currentSnapshot() };
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
      value.recent_messages = Object.fromEntries(messageChannelIds.map((id) => [id, []]));
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
        if (method === 'PATCH' && path === `/guilds/${GUILD}`) {
          Object.assign(state.snapshot.guild, options.body);
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
    expect(baseline.guild_fields.features).toContain('COMMUNITY');
    expect(state.snapshot.channels.map((channel) => channel.id)).toEqual([CANARY_CHANNEL]);
    expect(state.snapshot.roles.some((role) => role.id === EXTRA_ROLE)).toBe(false);
    const guildPatch = calls.findIndex(
      ([method, path]) => method === 'PATCH' && path === `/guilds/${GUILD}`,
    );
    const firstChannelDelete = calls.findIndex(
      ([method, path]) => method === 'DELETE' && path.startsWith('/channels/'),
    );
    expect(guildPatch).toBeGreaterThan(-1);
    expect(guildPatch).toBeLessThan(firstChannelDelete);
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
    const baseline = makeBaseline();
    baseline.baseline_snapshot.channels[0].permission_overwrites = [
      { id: GUILD, type: 0, allow: '0', deny: '0' },
    ];

    await expect(
      verifyBenchmarkBaseline({
        ...dependencies({ snapshot: baselineSnapshot() }),
        baseline,
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
    const result = await restoreBenchmarkBaseline({
      rest,
      ...dependencies(state),
      baseline: makeBaseline(),
      cleanup: {
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
    });
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
      cleanup: {
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
    const common = { rest, ...dependencies(state), baseline: makeBaseline(), reason: 'test' };
    await expect(
      restoreBenchmarkBaseline({
        ...common,
        cleanup: {
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
    await expect(
      restoreBenchmarkBaseline({
        rest,
        ...dependencies(state, { drift: true }),
        sleep: async () => undefined,
        baseline: makeBaseline(),
        cleanup: {
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
      }),
    ).rejects.toThrow('QUARANTINE');
  });
});
