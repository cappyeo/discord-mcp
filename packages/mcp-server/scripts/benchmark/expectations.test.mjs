import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildBenchmarkExpectations } from './expectations.mjs';

const guildId = '10000000000000001';
const botId = '10000000000000002';
const ids = {
  member: '10000000000000011',
  helper: '10000000000000012',
  category: '10000000000000021',
  channel: '10000000000000022',
  rule: '10000000000000031',
  publication: '10000000000000041',
  canaryRole: '10000000000000051',
  canaryChannel: '10000000000000052',
  botRole: '10000000000000061',
  managedRole: '10000000000000062',
};

function blueprint() {
  return {
    roles: [
      {
        key: 'member',
        permissions: [
          'VIEW_CHANNEL',
          'READ_MESSAGE_HISTORY',
          'SEND_MESSAGES',
          'ADD_REACTIONS',
          'EMBED_LINKS',
          'ATTACH_FILES',
          'USE_APPLICATION_COMMANDS',
          'CREATE_PUBLIC_THREADS',
          'SEND_MESSAGES_IN_THREADS',
          'CONNECT',
          'SPEAK',
          'STREAM',
          'USE_VAD',
          'USE_EMBEDDED_ACTIVITIES',
          'MANAGE_MESSAGES',
          'MANAGE_THREADS',
          'VIEW_AUDIT_LOG',
          'KICK_MEMBERS',
          'MODERATE_MEMBERS',
          'CREATE_EVENTS',
          'MANAGE_EVENTS',
          'MANAGE_CHANNELS',
          'MANAGE_ROLES',
          'MANAGE_GUILD',
          'ADMINISTRATOR',
        ],
      },
      { key: 'helper', permissions: ['MANAGE_MESSAGES'] },
    ],
    categories: [
      {
        key: 'start',
        overwrites: [
          { subject: { kind: 'everyone' }, allow: ['VIEW_CHANNEL'], deny: [] },
          { subject: { kind: 'bot' }, allow: ['SEND_MESSAGES'], deny: [] },
          { subject: { kind: 'role', key: 'member' }, allow: ['ADD_REACTIONS'], deny: [] },
        ],
      },
    ],
    channels: [
      {
        key: 'general',
        parent_key: 'start',
        overwrites: [{ subject: { kind: 'everyone' }, allow: ['SEND_MESSAGES'], deny: [] }],
      },
    ],
    guild: {
      community: {
        rules_channel_key: 'general',
        public_updates_channel_key: 'general',
        safety_alerts_channel_key: 'general',
      },
      welcome_screen: { channel_keys: ['general'] },
    },
    onboarding: {
      default_channel_keys: ['general'],
      prompts: [
        {
          options: [{ role_keys: ['member'], channel_keys: ['general'] }],
        },
      ],
    },
    automod: {
      rules: [
        {
          key: 'safety',
          actions: [{ alert_channel_key: 'general' }],
          exempt_role_keys: ['helper'],
          exempt_channel_keys: ['general'],
        },
      ],
    },
    components_v2: {
      publications: [{ key: 'welcome', channel_key: 'general' }],
    },
  };
}

function bindings() {
  return {
    roles: { member: ids.member, helper: ids.helper },
    categories: { start: ids.category },
    channels: { general: ids.channel },
    automod_rules: { safety: ids.rule },
    publications: { welcome: ids.publication },
  };
}

function before() {
  return {
    guild: { id: guildId },
    bot: { user: { id: botId }, roles: [ids.botRole] },
    roles: [
      { id: guildId, managed: false },
      { id: ids.canaryRole, managed: false },
      { id: ids.botRole, managed: false },
      { id: ids.managedRole, managed: true },
    ],
    channels: [{ id: ids.canaryChannel }],
    automod_rules: [],
    recent_messages: {},
  };
}

test('builds independent JSON expectations for permissions, overwrites, bindings, and publications', () => {
  const expected = buildBenchmarkExpectations({
    blueprint: blueprint(),
    bindings: bindings(),
    before: before(),
    guildId,
    botId,
  });
  assert.deepEqual(expected.generated.channels, [ids.category, ids.channel]);
  assert.deepEqual(expected.bindings.channels, { start: ids.category, general: ids.channel });
  assert.deepEqual(expected.generated.messages, [ids.publication]);
  assert.deepEqual(expected.canary, { roles: [ids.canaryRole], channels: [ids.canaryChannel] });
  assert.equal(typeof expected.generated_role_permissions[ids.member], 'string');
  assert.notEqual(
    BigInt(expected.generated_role_permissions[ids.member]) & (1n << 44n),
    0n,
    'CREATE_EVENTS uses Discord permission bit 44',
  );
  assert.equal(expected.generated_role_permissions[ids.helper], '8192');
  assert.equal(expected.allowed_overwrite_allows[`${ids.category}:0:${guildId}`], '1024');
  assert.equal(expected.allowed_overwrite_allows[`${ids.category}:1:${botId}`], '2048');
  assert.equal(expected.allowed_overwrite_allows[`${ids.category}:0:${ids.member}`], '64');
  assert.equal(expected.allowed_overwrite_allows[`${ids.channel}:0:${guildId}`], '2048');
  assert.deepEqual(expected.allowed_state_changes, {
    guild: true,
    onboarding: true,
    welcome: true,
  });
  assert.doesNotThrow(() => JSON.stringify(expected));
});

test('fails closed for unknown permission, reference, binding, duplicate, and preexisting IDs', () => {
  const unknownPermission = blueprint();
  unknownPermission.roles[0].permissions = ['NOT_A_PERMISSION'];
  assert.throws(
    () =>
      buildBenchmarkExpectations({
        blueprint: unknownPermission,
        bindings: bindings(),
        before: before(),
        guildId,
        botId,
      }),
    /unknown permission/,
  );
  assert.throws(
    () =>
      buildBenchmarkExpectations({
        blueprint: {
          ...blueprint(),
          channels: [{ ...blueprint().channels[0], parent_key: 'missing' }],
        },
        bindings: bindings(),
        before: before(),
        guildId,
        botId,
      }),
    /unknown.*reference/,
  );
  assert.throws(
    () =>
      buildBenchmarkExpectations({
        blueprint: blueprint(),
        bindings: { ...bindings(), channels: {} },
        before: before(),
        guildId,
        botId,
      }),
    /keyset/,
  );
  assert.throws(
    () =>
      buildBenchmarkExpectations({
        blueprint: blueprint(),
        bindings: { ...bindings(), channels: { general: ids.category } },
        before: before(),
        guildId,
        botId,
      }),
    /duplicate binding resource ID/,
  );
  assert.throws(
    () =>
      buildBenchmarkExpectations({
        blueprint: blueprint(),
        bindings: { ...bindings(), roles: { member: ids.canaryRole, helper: ids.helper } },
        before: before(),
        guildId,
        botId,
      }),
    /already exists/,
  );
});
