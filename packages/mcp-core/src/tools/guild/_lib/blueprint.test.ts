import { describe, expect, it } from 'vitest';
import {
  assertBlueprintSafe,
  blueprintFingerprint,
  compileGuildBlueprint,
  type GuildBlueprint,
} from './blueprint.js';

function source(
  capabilities: Parameters<typeof compileGuildBlueprint>[0]['primary']['effective_capabilities'],
  overrides: Partial<Parameters<typeof compileGuildBlueprint>[0]['primary']['blueprint']> = {},
) {
  return {
    code: 'safe-primary',
    effective_capabilities: capabilities,
    blueprint: {
      channel_count: 31,
      category_count: 6,
      text_channel_count: 18,
      voice_channel_count: 6,
      forum_channel_count: 1,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 24,
      role_count: 12,
      privileged_role_count: 0,
      risky_permission_signals: [],
      ...overrides,
    },
  };
}

function gamingBlueprint() {
  return compileGuildBlueprint({
    request: 'Dựng cho tôi một server gaming chuyên nghiệp có LFG, voice và sự kiện',
    requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
    primary: source(['gaming', 'lfg', 'voice', 'platform']),
    inspirations: [source(['events', 'forum'])],
  });
}

describe('guild blueprint compiler', () => {
  it('compiles a deterministic complete gaming blueprint from symbolic trusted evidence', () => {
    const first = gamingBlueprint();
    const second = gamingBlueprint();

    expect(first).toEqual(second);
    expect(blueprintFingerprint(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(blueprintFingerprint(first)).toBe(blueprintFingerprint(second));
    expect(first).toMatchObject({
      schema_version: 'guild_blueprint.v1',
      policy_version: 'community-safe.v1',
      profile: 'professional_gaming',
      guild: {
        name: 'Cộng đồng Gaming',
        preferred_locale: 'vi',
        verification_level: 2,
        default_message_notifications: 1,
        explicit_content_filter: 2,
      },
      onboarding: { enabled: true, mode: 1 },
      automod: { verification: 'read_after_write' },
      components_v2: {
        flags: 32_768,
        validate_before_send: true,
        resolve_channel_placeholders_before_send: true,
      },
      safety: {
        source_permissions_discarded: true,
        source_overwrites_discarded: true,
        severe_generated_role_permissions: 0,
        dangling_symbolic_references: 0,
        onboarding_requirements_met: true,
        components_v2_pre_resolution_valid: true,
      },
    });
    expect(first.channels.map((item) => item.key)).toEqual(
      expect.arrayContaining(['rules', 'general', 'lfg', 'lobby', 'mod_log']),
    );
    expect(first.roles.map((item) => item.key)).toEqual(
      expect.arrayContaining(['member', 'moderator', 'pc', 'lfg', 'event_host']),
    );
    expect(first.onboarding.default_channel_keys).toHaveLength(8);
    expect(
      first.onboarding.default_channel_keys.filter(
        (key) => first.channels.find((channel) => channel.key === key)?.everyone_sendable,
      ),
    ).toHaveLength(5);
    expect(first.automod.rules.map((rule) => rule.trigger_type)).toEqual([4, 5, 3]);
    expect(first.components_v2.publications).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(32_000);
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as GuildBlueprint;
    expect(blueprintFingerprint(reordered)).toBe(blueprintFingerprint(first));
    assertBlueprintSafe(first);
  });

  it('never allows source permission evidence or source identifiers into desired state', () => {
    const baseline = gamingBlueprint();
    const hostile = compileGuildBlueprint({
      request: 'Dựng cho tôi một server gaming chuyên nghiệp có LFG, voice và sự kiện',
      requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
      primary: source(['gaming', 'lfg', 'voice', 'platform'], {
        privileged_role_count: 99,
        risky_permission_signals: [
          { permission: 'ADMINISTRATOR', role_count: 99 },
          { permission: 'MANAGE_ROLES', role_count: 99 },
        ],
      }),
      inspirations: [
        {
          ...source(['events', 'forum']),
          code: '999999999999999999',
        },
      ],
    });

    expect(hostile).toEqual(baseline);
    const serialized = JSON.stringify(hostile);
    expect(serialized).not.toContain('safe-primary');
    expect(serialized).not.toContain('999999999999999999');
    expect(hostile.roles.flatMap((role) => role.permissions)).not.toEqual(
      expect.arrayContaining(['ADMINISTRATOR', 'MANAGE_ROLES', 'MANAGE_GUILD']),
    );
  });

  it('selects a technology module without making the compiler template-text dependent', () => {
    const blueprint = compileGuildBlueprint({
      request: 'Build a professional technology learning community',
      requested_capabilities: ['technology', 'learning', 'forum'],
      primary: source(['technology', 'forum']),
      inspirations: [],
    });

    expect(blueprint.profile).toBe('professional_technology');
    expect(blueprint.channels.map((item) => item.key)).toEqual(
      expect.arrayContaining(['tech_talk', 'help_forum', 'resources']),
    );
    expect(blueprint.roles.map((item) => item.key)).toEqual(
      expect.arrayContaining(['developer', 'designer']),
    );
    assertBlueprintSafe(blueprint);
  });

  it('fails closed on dangerous role permissions, onboarding drift, and dangling symbols', () => {
    const dangerous = structuredClone(gamingBlueprint()) as GuildBlueprint;
    dangerous.roles[0]!.permissions.push('ADMINISTRATOR');
    expect(() => assertBlueprintSafe(dangerous)).toThrow('forbidden permission');

    const onboardingDrift = structuredClone(gamingBlueprint()) as GuildBlueprint;
    onboardingDrift.onboarding.default_channel_keys =
      onboardingDrift.onboarding.default_channel_keys.slice(0, 6);
    expect(() => assertBlueprintSafe(onboardingDrift)).toThrow('expected array to have >=7 items');

    const dangling = structuredClone(gamingBlueprint()) as GuildBlueprint;
    dangling.components_v2.publications[0]!.components = [
      {
        type: 17,
        components: [{ type: 10, content: 'Read <#{{channel:missing}}>' }],
      },
    ];
    expect(() => assertBlueprintSafe(dangling)).toThrow('dangling channel symbol');

    const dangerousOverwrite = structuredClone(gamingBlueprint()) as GuildBlueprint;
    dangerousOverwrite.channels[0]!.overwrites.push({
      subject: { kind: 'role', key: 'member' },
      allow: ['MANAGE_GUILD'],
      deny: [],
    });
    expect(() => assertBlueprintSafe(dangerousOverwrite)).toThrow(
      'permission that is invalid in an overwrite',
    );

    const inheritedWrite = structuredClone(gamingBlueprint()) as GuildBlueprint;
    inheritedWrite.channels[0]!.overwrites = [];
    inheritedWrite.categories.find((item) => item.key === 'start_here')!.overwrites = [
      { subject: { kind: 'everyone' }, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'], deny: [] },
    ];
    expect(() => assertBlueprintSafe(inheritedWrite)).toThrow(
      'everyone_sendable does not match effective SEND_MESSAGES',
    );

    const exemptReference = structuredClone(gamingBlueprint()) as GuildBlueprint;
    exemptReference.automod.rules[0]!.exempt_role_keys = ['missing'];
    expect(() => assertBlueprintSafe(exemptReference)).toThrow('unknown exempt role');

    const invalidAutoModAction = structuredClone(gamingBlueprint()) as GuildBlueprint;
    invalidAutoModAction.automod.rules[0]!.actions[1]!.alert_channel_key = null;
    expect(() => assertBlueprintSafe(invalidAutoModAction)).toThrow(
      'SEND_ALERT_MESSAGE requires an alert channel',
    );

    const missingPreset = structuredClone(gamingBlueprint()) as GuildBlueprint;
    missingPreset.automod.rules[0]!.presets = [];
    expect(() => assertBlueprintSafe(missingPreset)).toThrow(
      'requires at least one keyword preset',
    );

    const communityReference = structuredClone(gamingBlueprint()) as GuildBlueprint;
    communityReference.guild.community.rules_channel_key = 'missing';
    expect(() => assertBlueprintSafe(communityReference)).toThrow(
      'Community settings reference an unknown channel',
    );

    const privateWelcome = structuredClone(gamingBlueprint()) as GuildBlueprint;
    privateWelcome.guild.welcome_screen.channel_keys[0] = 'mod_log';
    expect(() => assertBlueprintSafe(privateWelcome)).toThrow(
      'Welcome Screen must use public, everyone-visible',
    );

    const wrongCommunityType = structuredClone(gamingBlueprint()) as GuildBlueprint;
    wrongCommunityType.guild.community.rules_channel_key = 'lobby';
    expect(() => assertBlueprintSafe(wrongCommunityType)).toThrow(
      'Community rules must use a public text channel',
    );

    const incompatibleAutoModEvent = structuredClone(gamingBlueprint()) as GuildBlueprint;
    incompatibleAutoModEvent.automod.rules[0]!.event_type = 2;
    expect(() => assertBlueprintSafe(incompatibleAutoModEvent)).toThrow(
      'incompatible event and trigger type',
    );

    const malformedPlaceholder = structuredClone(gamingBlueprint()) as GuildBlueprint;
    malformedPlaceholder.components_v2.publications[0]!.components = [
      { type: 17, components: [{ type: 10, content: 'Read <#{{channel:rules}' }] },
    ];
    expect(() => assertBlueprintSafe(malformedPlaceholder)).toThrow('malformed channel symbol');

    const unknownField = structuredClone(gamingBlueprint()) as GuildBlueprint & { surprise: true };
    unknownField.surprise = true;
    expect(() => assertBlueprintSafe(unknownField)).toThrow('Unrecognized key');
  });

  it('rejects empty keyword rules and member-profile triggers with message events', () => {
    const emptyKeyword = structuredClone(gamingBlueprint()) as GuildBlueprint;
    emptyKeyword.automod.rules[2]!.trigger_type = 1;
    expect(() => assertBlueprintSafe(emptyKeyword)).toThrow('requires a keyword or regex pattern');

    const wrongMemberProfileEvent = structuredClone(gamingBlueprint()) as GuildBlueprint;
    wrongMemberProfileEvent.automod.rules[2]!.trigger_type = 6;
    expect(() => assertBlueprintSafe(wrongMemberProfileEvent)).toThrow(
      'incompatible event and trigger type',
    );
  });
});
