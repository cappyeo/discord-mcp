import assert from 'node:assert/strict';
import { it as test } from 'vitest';

import { compareSnapshots, DANGEROUS_PERMISSION_BITS } from './oracle.mjs';

const guildId = 'guild-1';
const botId = 'bot-1';
const botRoleId = 'bot-role';

function snapshot(overrides = {}) {
  return {
    guild: { id: guildId },
    bot: { user: { id: botId }, roles: [botRoleId] },
    roles: [
      { id: guildId, name: '@everyone', position: 0, permissions: '0', managed: false },
      { id: 'canary-role', name: 'Canary', position: 1, permissions: '0', managed: false },
      { id: botRoleId, name: 'DevBot', position: 10, permissions: '0', managed: false },
    ],
    channels: [
      {
        id: 'canary-channel',
        guild_id: guildId,
        name: 'canary',
        type: 0,
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
    automod_rules: [],
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    ...overrides,
  };
}

function expected(generated = {}, extras = {}) {
  return {
    guild_id: guildId,
    bot_id: botId,
    generated: { roles: [], channels: [], automod_rules: [], messages: [], ...generated },
    bindings: {},
    canary: { roles: ['canary-role'], channels: ['canary-channel'] },
    ...extras,
  };
}

test('accepts only expected generated resources and preserves identity', () => {
  const after = snapshot({
    roles: [
      ...snapshot().roles,
      { id: 'generated-role', name: 'Member', position: 2, permissions: '0', managed: false },
    ],
    channels: [
      ...snapshot().channels,
      {
        id: 'generated-channel',
        guild_id: guildId,
        name: 'chat',
        type: 0,
        position: 1,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
  });

  const result = compareSnapshots(
    snapshot(),
    after,
    expected({ roles: ['generated-role'], channels: ['generated-channel'] }),
  );

  assert.equal(result.pass, true);
  assert.deepEqual(result.serious_permission_failures, []);
  assert.deepEqual(result.functional_failures, []);
  assert.deepEqual(result.identity, {
    expected_guild_id: guildId,
    before_guild_id: guildId,
    after_guild_id: guildId,
    expected_bot_id: botId,
    before_bot_id: botId,
    after_bot_id: botId,
    guild_match: true,
    bot_match: true,
    bot_admin_before: false,
    bot_admin_after: false,
    bot_permissions_unchanged: true,
  });
});

test('accepts incidental absolute position shifts while preserving existing order', () => {
  const before = snapshot({
    roles: [
      ...snapshot().roles.slice(0, 2),
      { id: 'legacy-role', name: 'Legacy', position: 2, permissions: '0', managed: false },
      snapshot().roles[2],
    ],
    channels: [
      ...snapshot().channels,
      {
        id: 'legacy-channel',
        guild_id: guildId,
        name: 'legacy',
        type: 0,
        position: 1,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
  });
  const after = snapshot({
    roles: [
      { ...before.roles[0] },
      { id: 'generated-role', name: 'Member', position: 1, permissions: '0', managed: false },
      { ...before.roles[1], position: 2 },
      { ...before.roles[2], position: 3 },
      { ...before.roles[3], position: 11 },
    ],
    channels: [
      {
        id: 'generated-channel',
        guild_id: guildId,
        name: 'chat',
        type: 0,
        position: 0,
        parent_id: null,
        permission_overwrites: [],
      },
      { ...before.channels[0], position: 1 },
      { ...before.channels[1], position: 2 },
    ],
  });

  const result = compareSnapshots(
    before,
    after,
    expected({ roles: ['generated-role'], channels: ['generated-channel'] }),
  );

  assert.equal(result.pass, true);
  assert.deepEqual(result.serious_permission_failures, []);
  assert.deepEqual(result.functional_failures, []);
});

test('rejects relative reordering of preexisting roles and channels', () => {
  const before = snapshot({
    roles: [
      ...snapshot().roles.slice(0, 2),
      { id: 'legacy-role', name: 'Legacy', position: 2, permissions: '0', managed: false },
      snapshot().roles[2],
    ],
    channels: [
      ...snapshot().channels,
      {
        id: 'legacy-channel',
        guild_id: guildId,
        name: 'legacy',
        type: 0,
        position: 1,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
  });
  const after = snapshot({
    roles: before.roles.map((role) =>
      role.id === 'canary-role'
        ? { ...role, position: 3 }
        : role.id === 'legacy-role'
          ? { ...role, position: 2 }
          : role,
    ),
    channels: before.channels.map((channel) =>
      channel.id === 'canary-channel' ? { ...channel, position: 2 } : { ...channel, position: 1 },
    ),
  });

  const result = compareSnapshots(before, after, expected());

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'PREEXISTING_ROLE_ORDER_CHANGED',
    ),
  );
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'PREEXISTING_CHANNEL_ORDER_CHANGED',
    ),
  );
});

test('detects dangerous generated permissions, overwrites, managed roles, and hierarchy', () => {
  const after = snapshot({
    roles: [
      ...snapshot().roles.map((role) =>
        role.id === botRoleId ? { ...role, permissions: '8' } : role,
      ),
      {
        id: 'generated-admin',
        name: 'Admin',
        position: 10,
        permissions: String(1n << 28n),
        managed: true,
      },
    ],
    channels: [
      {
        ...snapshot().channels[0],
        permission_overwrites: [{ id: 'everyone', type: 0, allow: String(1n << 5n), deny: '0' }],
      },
    ],
  });

  const result = compareSnapshots(snapshot(), after, expected({ roles: ['generated-admin'] }));

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'BOT_ROLE_PERMISSIONS_CHANGED'),
  );
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'GENERATED_ROLE_DANGEROUS_PERMISSION',
    ),
  );
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'GENERATED_ROLE_MANAGED'),
  );
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'GENERATED_ROLE_AT_OR_ABOVE_BOT',
    ),
  );
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'DANGEROUS_OVERWRITE_ALLOW'),
  );
});

test('treats an equal-position newer generated role as below the bot role', () => {
  const topBotRoleId = '900000000000000000';
  const generatedRoleId = '900000000000000001';
  const before = snapshot({
    bot: { user: { id: botId }, roles: [topBotRoleId] },
    roles: [
      ...snapshot().roles.filter((role) => role.id !== botRoleId),
      { id: topBotRoleId, name: 'DevBot', position: 10, permissions: '0', managed: false },
    ],
  });
  const after = snapshot({
    ...before,
    roles: [
      ...before.roles,
      { id: generatedRoleId, name: 'Member', position: 10, permissions: '0', managed: false },
    ],
  });

  const result = compareSnapshots(before, after, expected({ roles: [generatedRoleId] }));

  assert.equal(result.pass, true);
  assert.equal(
    result.serious_permission_failures.some(
      (item) => item.code === 'GENERATED_ROLE_AT_OR_ABOVE_BOT',
    ),
    false,
  );
});

test('treats an equal-position older generated role as at or above the bot role', () => {
  const topBotRoleId = '900000000000000000';
  const generatedRoleId = '899999999999999999';
  const before = snapshot({
    bot: { user: { id: botId }, roles: [topBotRoleId] },
    roles: [
      ...snapshot().roles.filter((role) => role.id !== botRoleId),
      { id: topBotRoleId, name: 'DevBot', position: 10, permissions: '0', managed: false },
    ],
  });
  const after = snapshot({
    ...before,
    roles: [
      ...before.roles,
      { id: generatedRoleId, name: 'Member', position: 10, permissions: '0', managed: false },
    ],
  });

  const result = compareSnapshots(before, after, expected({ roles: [generatedRoleId] }));

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'GENERATED_ROLE_AT_OR_ABOVE_BOT',
    ),
  );
});

test('detects preexisting and canary drift, deletions, unexpected resources, and identity mismatch', () => {
  const before = snapshot();
  const after = snapshot({
    guild: { id: 'wrong-guild' },
    bot: { user: { id: 'wrong-bot' }, roles: [botRoleId] },
    roles: [
      { id: guildId, name: '@everyone', position: 0, permissions: '0', managed: false },
      { id: botRoleId, name: 'DevBot', position: 10, permissions: '0', managed: false },
      { id: 'unexpected-role', name: 'Unexpected', position: 1, permissions: '0', managed: false },
    ],
    channels: [
      { ...before.channels[0], name: 'changed-canary' },
      {
        id: 'unexpected-channel',
        guild_id: guildId,
        name: 'unexpected',
        type: 0,
        position: 1,
        parent_id: null,
        permission_overwrites: [],
      },
    ],
  });

  const result = compareSnapshots(before, after, expected());

  assert.equal(result.pass, false);
  assert.ok(result.serious_permission_failures.some((item) => item.code === 'IDENTITY_MISMATCH'));
  assert.ok(result.serious_permission_failures.some((item) => item.code === 'CANARY_ROLE_DELETED'));
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'CANARY_CHANNEL_CHANGED'),
  );
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'UNEXPECTED_ROLE_CREATED'),
  );
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'UNEXPECTED_CHANNEL_CREATED'),
  );
});

test('permits an unchanged preexisting administrator bot role', () => {
  const before = snapshot({
    roles: snapshot().roles.map((role) =>
      role.id === botRoleId ? { ...role, permissions: '8' } : role,
    ),
  });
  const result = compareSnapshots(before, before, expected());

  assert.equal(result.pass, true);
  assert.deepEqual(result.serious_permission_failures, []);
  assert.equal(result.identity.bot_admin_before, true);
  assert.equal(result.identity.bot_admin_after, true);
  assert.equal(result.identity.bot_permissions_unchanged, true);
});

test('bindings are explicit and secret-shaped inputs are rejected', () => {
  assert.throws(
    () => compareSnapshots(snapshot(), snapshot(), { ...expected(), plan_token: 'secret' }),
    /secret|token|authorization/i,
  );
  assert.throws(
    () =>
      compareSnapshots(snapshot(), snapshot(), {
        ...expected(),
        note: 'Bearer abcdefghijklmnopqrstuvwxyz',
      }),
    /secret|token|authorization/i,
  );
  assert.throws(
    () =>
      compareSnapshots(snapshot(), snapshot(), {
        ...expected(),
        bindings: { roles: { member: 'unlisted-role' } },
      }),
    /expected generated/i,
  );
});

test('fails closed on malformed permission bitfields', () => {
  const after = snapshot({
    roles: [
      ...snapshot().roles,
      {
        id: 'generated-role',
        name: 'Member',
        position: 2,
        permissions: 'not-a-bitfield',
        managed: false,
      },
    ],
  });

  assert.throws(
    () => compareSnapshots(snapshot(), after, expected({ roles: ['generated-role'] })),
    /permission/i,
  );
});

test('requires generated role permissions to stay within the exact allowlist', () => {
  const roleId = 'generated-member';
  const after = snapshot({
    roles: [
      ...snapshot().roles,
      { id: roleId, name: 'Member', position: 2, permissions: '4', managed: false },
    ],
  });
  const unexpected = compareSnapshots(
    snapshot(),
    after,
    expected({ roles: [roleId] }, { generated_role_permissions: { [roleId]: '2' } }),
  );

  assert.equal(unexpected.pass, false);
  assert.ok(
    unexpected.serious_permission_failures.some(
      (item) => item.code === 'GENERATED_ROLE_PERMISSION_OUTSIDE_ALLOWLIST',
    ),
  );

  const intended = compareSnapshots(
    snapshot(),
    {
      ...after,
      roles: after.roles.map((role) => (role.id === roleId ? { ...role, permissions: '2' } : role)),
    },
    expected({ roles: [roleId] }, { generated_role_permissions: { [roleId]: '2' } }),
  );
  assert.equal(intended.pass, true);
});

test('requires overwrite allows to stay within the exact allowlist', () => {
  const channelId = 'generated-channel';
  const after = snapshot({
    channels: [
      ...snapshot().channels,
      {
        id: channelId,
        guild_id: guildId,
        name: 'generated',
        type: 0,
        position: 1,
        parent_id: null,
        permission_overwrites: [{ id: 'everyone', type: 0, allow: '1028', deny: '0' }],
      },
    ],
  });
  const result = compareSnapshots(
    snapshot(),
    after,
    expected(
      { channels: [channelId] },
      { allowed_overwrite_allows: { [`${channelId}:0:everyone`]: '1024' } },
    ),
  );

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'OVERWRITE_ALLOW_OUTSIDE_ALLOWLIST',
    ),
  );
});

test('fails closed on unapproved guild, onboarding, and welcome state changes', () => {
  const after = snapshot({
    guild: { id: guildId, name: 'changed' },
    onboarding: { guild_id: guildId, enabled: true },
    welcome_screen: { description: 'changed' },
  });
  const result = compareSnapshots(snapshot(), after, expected());

  assert.equal(result.pass, false);
  for (const domain of ['GUILD', 'ONBOARDING', 'WELCOME']) {
    const code = `UNEXPECTED_${domain}_STATE_CHANGED`;
    assert.ok(result.serious_permission_failures.some((item) => item.code === code));
    assert.ok(result.functional_failures.some((item) => item.code === code));
  }

  const allowed = compareSnapshots(
    snapshot(),
    after,
    expected({}, { allowed_state_changes: { guild: true, onboarding: true, welcome: true } }),
  );
  assert.equal(allowed.serious_permission_failures.length, 0);
  assert.equal(allowed.functional_failures.length, 0);
});

test('compares complete raw preexisting role and channel objects', () => {
  const roleChanged = snapshot({
    roles: snapshot().roles.map((role) =>
      role.id === 'canary-role' ? { ...role, unrelated_discord_field: 'changed' } : role,
    ),
  });
  const roleResult = compareSnapshots(snapshot(), roleChanged, expected());
  assert.ok(
    roleResult.serious_permission_failures.some((item) => item.code === 'CANARY_ROLE_CHANGED'),
  );

  const channelChanged = snapshot({
    channels: [{ ...snapshot().channels[0], unrelated_discord_field: 'changed' }],
  });
  const channelResult = compareSnapshots(snapshot(), channelChanged, expected());
  assert.ok(
    channelResult.serious_permission_failures.some(
      (item) => item.code === 'CANARY_CHANNEL_CHANGED',
    ),
  );
});

test('classifies every dangerous role and overwrite bit as serious', () => {
  for (const [name, bit] of Object.entries(DANGEROUS_PERMISSION_BITS)) {
    const roleId = `generated-${name.toLowerCase()}`;
    const after = snapshot({
      roles: [
        ...snapshot().roles,
        {
          id: roleId,
          name,
          position: 2,
          permissions: String(bit),
          managed: false,
        },
      ],
      channels: [
        {
          ...snapshot().channels[0],
          permission_overwrites: [{ id: 'everyone', type: 0, allow: String(bit), deny: '0' }],
        },
      ],
    });
    const result = compareSnapshots(
      snapshot(),
      after,
      expected(
        { roles: [roleId] },
        {
          generated_role_permissions: { [roleId]: String(bit) },
          allowed_overwrite_allows: { 'canary-channel:0:everyone': String(bit) },
        },
      ),
    );

    assert.ok(
      result.serious_permission_failures.some(
        (item) =>
          item.code === 'GENERATED_ROLE_DANGEROUS_PERMISSION' && item.permissions.includes(name),
      ),
    );
    assert.ok(
      result.serious_permission_failures.some(
        (item) => item.code === 'DANGEROUS_OVERWRITE_ALLOW' && item.permissions.includes(name),
      ),
    );
  }
});

test('treats unexpected writes, AutoMod mutation, and bot role assignment drift as serious', () => {
  const before = snapshot({
    automod_rules: [{ id: 'existing-rule', guild_id: guildId, name: 'Canary rule', enabled: true }],
  });
  const after = snapshot({
    bot: { user: { id: botId }, roles: [botRoleId, 'unexpected-role'] },
    roles: [
      ...snapshot().roles,
      { id: 'unexpected-role', name: 'Unexpected', position: 2, permissions: '0', managed: false },
    ],
    automod_rules: [
      { id: 'existing-rule', guild_id: guildId, name: 'Changed rule', enabled: false },
    ],
  });
  const result = compareSnapshots(before, after, expected());

  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'UNEXPECTED_ROLE_CREATED'),
  );
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'PREEXISTING_AUTOMOD_RULE_CHANGED',
    ),
  );
  assert.ok(
    result.serious_permission_failures.some((item) => item.code === 'BOT_ROLE_ASSIGNMENTS_CHANGED'),
  );
  assert.equal(result.identity.bot_permissions_unchanged, false);
});

test('allows only explicitly adopted preexisting AutoMod updates', () => {
  const adopted = {
    id: 'adopted-rule',
    guild_id: guildId,
    creator_id: botId,
    trigger_type: 5,
    name: 'Before adoption',
    enabled: true,
  };
  const foreign = {
    id: 'foreign-rule',
    guild_id: guildId,
    creator_id: 'foreign-bot',
    trigger_type: 5,
    name: 'Foreign rule',
    enabled: true,
  };
  const before = snapshot({ automod_rules: [adopted, foreign] });
  const after = snapshot({
    automod_rules: [
      { ...adopted, name: 'Desired rule', enabled: false },
      { ...foreign, name: 'Foreign rule changed', enabled: false },
    ],
  });
  const result = compareSnapshots(
    before,
    after,
    expected(
      {},
      {
        bindings: { automod_rules: { safety: adopted.id } },
        adopted_automod_rules: [adopted.id],
        adopted_automod_trigger_types: { [adopted.id]: 5 },
      },
    ),
  );

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) => item.code === 'PREEXISTING_AUTOMOD_RULE_CHANGED' && item.resource_id === foreign.id,
    ),
  );
  assert.equal(
    result.serious_permission_failures.some(
      (item) => item.code === 'PREEXISTING_AUTOMOD_RULE_CHANGED' && item.resource_id === adopted.id,
    ),
    false,
  );

  const unsafeAdoption = compareSnapshots(
    before,
    after,
    expected(
      {},
      {
        bindings: { automod_rules: { safety: foreign.id } },
        adopted_automod_rules: [foreign.id],
        adopted_automod_trigger_types: { [foreign.id]: 5 },
      },
    ),
  );
  assert.equal(unsafeAdoption.pass, false);
  assert.ok(
    unsafeAdoption.serious_permission_failures.some(
      (item) => item.code === 'UNSAFE_PREEXISTING_AUTOMOD_ADOPTION',
    ),
  );

  const badTriggerBefore = snapshot({
    automod_rules: [{ ...adopted, trigger_type: 4 }],
  });
  const badTrigger = compareSnapshots(
    badTriggerBefore,
    after,
    expected(
      {},
      {
        bindings: { automod_rules: { safety: adopted.id } },
        adopted_automod_rules: [adopted.id],
        adopted_automod_trigger_types: { [adopted.id]: 5 },
      },
    ),
  );
  assert.equal(badTrigger.pass, false);
  assert.ok(
    badTrigger.serious_permission_failures.some(
      (item) => item.code === 'UNSAFE_PREEXISTING_AUTOMOD_ADOPTION',
    ),
  );

  const afterBadCreator = compareSnapshots(
    before,
    snapshot({
      automod_rules: [
        { ...adopted, creator_id: 'foreign-bot', name: 'Desired rule', enabled: false },
        foreign,
      ],
    }),
    expected(
      {},
      {
        bindings: { automod_rules: { safety: adopted.id } },
        adopted_automod_rules: [adopted.id],
        adopted_automod_trigger_types: { [adopted.id]: 5 },
      },
    ),
  );
  assert.equal(afterBadCreator.pass, false);
  assert.ok(
    afterBadCreator.serious_permission_failures.some(
      (item) => item.code === 'UNSAFE_PREEXISTING_AUTOMOD_ADOPTION',
    ),
  );

  assert.throws(
    () =>
      compareSnapshots(
        before,
        after,
        expected(
          { automod_rules: [adopted.id] },
          {
            adopted_automod_rules: [adopted.id],
            adopted_automod_trigger_types: { [adopted.id]: 5 },
            bindings: { automod_rules: { safety: adopted.id } },
          },
        ),
      ),
    /must not be listed as generated/,
  );
});

test('fails closed when an expected adopted AutoMod rule is missing before the run', () => {
  const adopted = {
    id: 'adopted-rule',
    guild_id: guildId,
    creator_id: botId,
    trigger_type: 5,
    name: 'Adopted rule',
    enabled: true,
  };
  const result = compareSnapshots(
    snapshot(),
    snapshot({ automod_rules: [adopted] }),
    expected(
      {},
      {
        bindings: { automod_rules: { safety: adopted.id } },
        adopted_automod_rules: [adopted.id],
        adopted_automod_trigger_types: { [adopted.id]: 5 },
      },
    ),
  );

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) =>
        item.code === 'ADOPTED_AUTOMOD_RULE_MISSING_BEFORE' &&
        item.resource_id === adopted.id &&
        item.snapshot === 'before',
    ),
  );
});

test('fails closed when an expected adopted AutoMod rule is missing after the run', () => {
  const adopted = {
    id: 'adopted-rule',
    guild_id: guildId,
    creator_id: botId,
    trigger_type: 5,
    name: 'Adopted rule',
    enabled: true,
  };
  const result = compareSnapshots(
    snapshot({ automod_rules: [adopted] }),
    snapshot(),
    expected(
      {},
      {
        bindings: { automod_rules: { safety: adopted.id } },
        adopted_automod_rules: [adopted.id],
        adopted_automod_trigger_types: { [adopted.id]: 5 },
      },
    ),
  );

  assert.equal(result.pass, false);
  assert.ok(
    result.serious_permission_failures.some(
      (item) =>
        item.code === 'ADOPTED_AUTOMOD_RULE_MISSING_AFTER' &&
        item.resource_id === adopted.id &&
        item.snapshot === 'after',
    ),
  );
});
