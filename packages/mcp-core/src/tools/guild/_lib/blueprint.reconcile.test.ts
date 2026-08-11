import { describe, expect, it } from 'vitest';
import { desiredAutoModBody, desiredRoleBody } from './blueprint.desired.js';
import { compileGuildBlueprint } from './blueprint.js';
import { reconcileGuildBlueprint } from './blueprint.reconcile.js';
import type { BlueprintTargetSnapshot, TargetAutoModRule, TargetRole } from './blueprint.target.js';

const blueprint = compileGuildBlueprint({
  request: 'Build a professional gaming community',
  requested_capabilities: ['gaming', 'lfg', 'voice'],
  primary: {
    code: 'primary',
    effective_capabilities: ['gaming', 'lfg', 'voice'],
    blueprint: {
      channel_count: 10,
      category_count: 2,
      text_channel_count: 6,
      voice_channel_count: 3,
      forum_channel_count: 0,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 4,
      role_count: 4,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  },
  inspirations: [],
});

const guildId = '100000000000000001';
const botId = '100000000000000002';

function baseSnapshot(
  roles: TargetRole[],
  automod_rules: TargetAutoModRule[] = [],
): BlueprintTargetSnapshot {
  return {
    guild: {
      id: guildId,
      name: 'Test',
      owner_id: '100000000000000003',
      description: null,
      preferred_locale: 'en-US',
      features: ['COMMUNITY'],
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
    },
    bot: { user: { id: botId }, roles: ['100000000000000010'] },
    roles,
    channels: [],
    automod_rules,
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    publication_history_complete: {},
  };
}

function botAndEveryone(): TargetRole[] {
  return [
    {
      id: guildId,
      name: '@everyone',
      color: 0,
      position: 0,
      permissions: '0',
      mentionable: false,
      hoist: false,
      managed: false,
    },
    {
      id: '100000000000000010',
      name: 'Bot',
      color: 0,
      position: 100,
      permissions: '8',
      mentionable: false,
      hoist: false,
      managed: false,
    },
  ];
}

function roleFor(key: string, id: string, overrides: Partial<TargetRole> = {}): TargetRole {
  const body = desiredRoleBody(blueprint.roles.find((role) => role.key === key)!);
  return {
    id,
    name: body.name as string,
    color: body.color as number,
    position: 10,
    permissions: body.permissions as string,
    mentionable: body.mentionable as boolean,
    hoist: body.hoist as boolean,
    managed: false,
    ...overrides,
  };
}

function automodRule(
  id: string,
  trigger_type: number,
  creator_id: string,
  overrides: Partial<TargetAutoModRule> = {},
): TargetAutoModRule {
  return {
    id,
    guild_id: guildId,
    creator_id,
    name: 'Existing rule',
    event_type: 1,
    trigger_type,
    trigger_metadata: {},
    actions: [],
    enabled: true,
    exempt_roles: [],
    exempt_channels: [],
    ...overrides,
  };
}

describe('guild blueprint reconciliation safety', () => {
  it('blocks duplicate unbound resources instead of guessing', () => {
    const member = blueprint.roles.find((role) => role.key === 'member')!;
    const snapshot = baseSnapshot([
      ...botAndEveryone(),
      roleFor(member.key, '100000000000000011'),
      roleFor(member.key, '100000000000000012'),
    ]);

    const result = reconcileGuildBlueprint(`sha256:${'3'.repeat(64)}`, blueprint, snapshot);

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_RESOURCE', resource: 'role-key:member' }),
      ]),
    );
    expect(result.bindings.roles.member).toBeUndefined();
    expect(result.operations.some((operation) => operation.key === 'member')).toBe(false);
  });

  it('blocks unbound drift rather than overwriting a similarly named role', () => {
    const member = blueprint.roles.find((role) => role.key === 'member')!;
    const snapshot = baseSnapshot([
      ...botAndEveryone(),
      roleFor(member.key, '100000000000000011', { color: 1 }),
    ]);

    const result = reconcileGuildBlueprint(`sha256:${'4'.repeat(64)}`, blueprint, snapshot);

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'RESOURCE_CONFLICT', resource: 'role:100000000000000011' }),
      ]),
    );
    expect(result.bindings.roles.member).toBeUndefined();
    expect(result.operations.some((operation) => operation.key === 'member')).toBe(false);
  });

  it('adopts a unique bot-owned singleton AutoMod rule and plans an update', () => {
    const existing = automodRule('100000000000000011', 3, botId);
    const result = reconcileGuildBlueprint(
      `sha256:${'5'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], [existing]),
    );

    expect(result.bindings.automod_rules.spam).toBe(existing.id);
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'update',
          resource: 'automod_rule',
          key: 'spam',
        }),
      ]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'create', resource: 'automod_rule', key: 'spam' }),
      ]),
    );
  });

  it('blocks a foreign-owned singleton AutoMod rule without creating or adopting it', () => {
    const existing = automodRule('100000000000000011', 3, '100000000000000099');
    const result = reconcileGuildBlueprint(
      `sha256:${'6'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], [existing]),
    );

    expect(result.bindings.automod_rules.spam).toBeUndefined();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE_CONFLICT',
          resource: `automod-rule:${existing.id}`,
        }),
      ]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'create', resource: 'automod_rule', key: 'spam' }),
      ]),
    );
  });

  it('blocks a foreign-owned bound AutoMod rule before reconciling a matching trigger', () => {
    const existing = automodRule('100000000000000013', 3, '100000000000000099');
    const result = reconcileGuildBlueprint(
      `sha256:${'8'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], [existing]),
      {
        roles: {},
        categories: {},
        channels: {},
        automod_rules: { spam: existing.id },
        publications: {},
      },
    );

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE_CONFLICT',
          resource: `automod-rule:${existing.id}`,
        }),
      ]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'update', resource: 'automod_rule', key: 'spam' }),
      ]),
    );
  });

  it('blocks duplicate singleton triggers before adopting a desired-name match', () => {
    const channelId = '100000000000000020';
    const seedBindings = {
      roles: {},
      categories: {},
      channels: { mod_log: channelId },
      automod_rules: {},
      publications: {},
    };
    const desired = blueprint.automod.rules.find((rule) => rule.key === 'spam')!;
    const body = desiredAutoModBody(desired, seedBindings)!;
    const exactMatch = automodRule('100000000000000013', 3, botId, {
      name: body.name as string,
      event_type: body.event_type as number,
      trigger_metadata: body.trigger_metadata as Record<string, unknown>,
      actions: body.actions as Array<Record<string, unknown>>,
      enabled: body.enabled as boolean,
      exempt_roles: body.exempt_roles as string[],
      exempt_channels: body.exempt_channels as string[],
    });
    const duplicate = automodRule('100000000000000014', 3, botId);
    const result = reconcileGuildBlueprint(
      `sha256:${'9'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], [exactMatch, duplicate]),
      seedBindings,
    );

    expect(result.bindings.automod_rules.spam).toBeUndefined();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_RESOURCE', resource: 'automod-key:spam' }),
      ]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resource: 'automod_rule', key: 'spam' })]),
    );
  });

  it('reports ownership conflict for an exact-name foreign singleton during preview', () => {
    const desired = blueprint.automod.rules.find((rule) => rule.key === 'spam')!;
    const existing = automodRule('100000000000000011', 3, '100000000000000099', {
      name: desired.name,
    });
    const result = reconcileGuildBlueprint(
      `sha256:${'6'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], [existing]),
    );

    expect(result.bindings.automod_rules.spam).toBeUndefined();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE_CONFLICT',
          message: expect.stringContaining('owned by another creator'),
          resource: `automod-rule:${existing.id}`,
        }),
      ]),
    );
  });

  it('fails closed when singleton AutoMod trigger candidates are ambiguous', () => {
    const rules = [
      automodRule('100000000000000011', 3, botId),
      automodRule('100000000000000012', 3, botId),
    ];
    const result = reconcileGuildBlueprint(
      `sha256:${'7'.repeat(64)}`,
      blueprint,
      baseSnapshot([...botAndEveryone()], rules),
    );

    expect(result.bindings.automod_rules.spam).toBeUndefined();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_RESOURCE', resource: 'automod-key:spam' }),
      ]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'create', resource: 'automod_rule', key: 'spam' }),
      ]),
    );
  });
});
