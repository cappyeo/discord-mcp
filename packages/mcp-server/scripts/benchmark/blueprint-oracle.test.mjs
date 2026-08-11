import { describe, expect, it } from 'vitest';
import { verifyBlueprintSnapshot } from './blueprint-oracle.mjs';

const GUILD_ID = '999000999000999000';
const BOT_ID = '888000888000888000';
const BOT_ROLE_ID = '777000777000777000';
const ROLE_ID = '700000700000700000';
const CATEGORY_ID = '600000600000600000';
const CHANNEL_ID = '500000500000500000';
const RULE_ID = '400000400000400000';
const MESSAGE_ID = '300000300000300000';
const BLUEPRINT_ID = `sha256:${'a'.repeat(64)}`;

function blueprint() {
  return {
    guild: {
      name: 'Gaming Guild',
      description: 'Professional gaming community',
      preferred_locale: 'en-US',
      verification_level: 2,
      default_message_notifications: 1,
      explicit_content_filter: 2,
      community: {
        rules_channel_key: 'rules',
        public_updates_channel_key: 'rules',
        safety_alerts_channel_key: 'rules',
      },
      welcome_screen: {
        enabled: true,
        description: 'Welcome aboard',
        channel_keys: ['rules'],
      },
    },
    roles: [
      {
        key: 'member',
        name: 'Member',
        position: 1,
        color: 0x5865f2,
        hoist: false,
        mentionable: false,
        permissions: ['VIEW_CHANNEL'],
      },
    ],
    role_order: ['member'],
    categories: [
      {
        key: 'start',
        name: 'START HERE',
        position: 0,
        overwrites: [
          {
            subject: { kind: 'everyone' },
            allow: ['VIEW_CHANNEL'],
            deny: ['SEND_MESSAGES'],
          },
        ],
      },
    ],
    channels: [
      {
        key: 'rules',
        name: 'rules',
        type: 'text',
        parent_key: 'start',
        position: 0,
        topic: 'Read the rules.',
        slowmode_seconds: 3,
        forum_tags: [],
        overwrites: [
          {
            subject: { kind: 'role', key: 'member' },
            allow: ['VIEW_CHANNEL'],
            deny: ['SEND_MESSAGES'],
          },
        ],
      },
    ],
    onboarding: {
      enabled: true,
      mode: 1,
      default_channel_keys: ['rules'],
      prompts: [
        {
          key: 'platform',
          type: 0,
          title: 'Choose access',
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              key: 'member_option',
              title: 'Member',
              description: 'Join the community',
              role_keys: ['member'],
              channel_keys: ['rules'],
            },
          ],
        },
      ],
    },
    automod: {
      rules: [
        {
          key: 'mentions',
          name: 'Block mention spam',
          event_type: 1,
          trigger_type: 5,
          keyword_filter: [],
          regex_patterns: [],
          presets: [],
          allow_list: [],
          mention_total_limit: 5,
          mention_raid_protection_enabled: true,
          actions: [
            {
              type: 1,
              alert_channel_key: null,
              duration_seconds: null,
              custom_message: 'Too many mentions',
            },
          ],
          exempt_role_keys: ['member'],
          exempt_channel_keys: ['rules'],
          enabled: true,
        },
      ],
    },
    components_v2: {
      flags: 32_768,
      publications: [
        {
          key: 'welcome',
          channel_key: 'rules',
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 17,
              components: [{ type: 10, content: 'Welcome to <#{{channel:rules}}>' }],
            },
          ],
        },
      ],
    },
  };
}

function bindings() {
  return {
    roles: { member: ROLE_ID },
    categories: { start: CATEGORY_ID },
    channels: { rules: CHANNEL_ID },
    automod_rules: { mentions: RULE_ID },
    publications: { welcome: MESSAGE_ID },
  };
}

function snapshot() {
  return {
    guild: {
      id: GUILD_ID,
      name: 'Gaming Guild',
      description: 'Professional gaming community',
      preferred_locale: 'en-US',
      features: ['COMMUNITY'],
      verification_level: 2,
      default_message_notifications: 1,
      explicit_content_filter: 2,
      rules_channel_id: CHANNEL_ID,
      public_updates_channel_id: CHANNEL_ID,
      safety_alerts_channel_id: CHANNEL_ID,
    },
    bot: { user: { id: BOT_ID }, roles: [BOT_ROLE_ID] },
    roles: [
      { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
      {
        id: ROLE_ID,
        name: 'Member',
        position: 1,
        permissions: '1024',
        color: 0x5865f2,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      { id: BOT_ROLE_ID, name: 'Bot', position: 10, permissions: '8', managed: true },
    ],
    channels: [
      {
        id: CATEGORY_ID,
        guild_id: GUILD_ID,
        name: 'START HERE',
        type: 4,
        position: 0,
        permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '1024', deny: '2048' }],
      },
      {
        id: CHANNEL_ID,
        guild_id: GUILD_ID,
        name: 'rules',
        type: 0,
        position: 0,
        parent_id: CATEGORY_ID,
        topic: 'Read the rules.',
        nsfw: false,
        rate_limit_per_user: 3,
        permission_overwrites: [{ id: ROLE_ID, type: 0, allow: '1024', deny: '2048' }],
        available_tags: [],
      },
    ],
    automod_rules: [
      {
        id: RULE_ID,
        guild_id: GUILD_ID,
        name: 'Block mention spam',
        event_type: 1,
        trigger_type: 5,
        trigger_metadata: {
          mention_total_limit: 5,
          mention_raid_protection_enabled: true,
        },
        actions: [{ type: 1, metadata: { custom_message: 'Too many mentions' } }],
        exempt_roles: [ROLE_ID],
        exempt_channels: [CHANNEL_ID],
        enabled: true,
      },
    ],
    onboarding: {
      guild_id: GUILD_ID,
      enabled: true,
      mode: 1,
      default_channel_ids: [CHANNEL_ID],
      prompts: [
        {
          id: '200000200000200000',
          type: 0,
          title: 'Choose access',
          single_select: true,
          required: true,
          in_onboarding: true,
          options: [
            {
              id: '100000100000100000',
              title: 'Member',
              description: 'Join the community',
              role_ids: [ROLE_ID],
              channel_ids: [CHANNEL_ID],
              emoji_id: null,
              emoji_name: null,
              emoji_animated: false,
            },
          ],
        },
      ],
    },
    welcome_screen: {
      description: 'Welcome aboard',
      welcome_channels: [
        {
          channel_id: CHANNEL_ID,
          description: 'Read the rules.',
          emoji_id: null,
          emoji_name: '👋',
        },
      ],
    },
    recent_messages: {
      [CHANNEL_ID]: [
        {
          id: MESSAGE_ID,
          channel_id: CHANNEL_ID,
          guild_id: GUILD_ID,
          author: { id: BOT_ID },
          flags: 32_768,
          nonce: 'dmc0123456789012345678901',
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          components: [
            {
              type: 17,
              components: [
                {
                  type: 10,
                  content:
                    'Welcome to <#500000500000500000>\n\n-# Managed by discord-mcp · blueprint aaaaaaaaaaaa · publication welcome',
                },
              ],
            },
          ],
        },
      ],
    },
    publication_history_complete: { [CHANNEL_ID]: true },
  };
}

describe('verifyBlueprintSnapshot', () => {
  it('independently verifies the complete bound blueprint graph', () => {
    const result = verifyBlueprintSnapshot({
      blueprint: blueprint(),
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      snapshot: snapshot(),
      guildId: GUILD_ID,
      botId: BOT_ID,
    });

    expect(result.match).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.verified_counts).toEqual({
      roles: 1,
      categories: 1,
      channels: 1,
      automod_rules: 1,
      publications: 1,
      onboarding_prompts: 1,
    });
  });

  it('accepts a verified publication when Discord omits the write-only nonce', () => {
    const current = snapshot();
    delete current.recent_messages[CHANNEL_ID][0].nonce;

    const result = verifyBlueprintSnapshot({
      blueprint: blueprint(),
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      snapshot: current,
      guildId: GUILD_ID,
      botId: BOT_ID,
    });

    expect(result.match).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports independent failures across permissions, routing, safety, and publication state', () => {
    const drifted = snapshot();
    drifted.roles.find((role) => role.id === ROLE_ID).permissions = '8';
    drifted.channels.find((channel) => channel.id === CHANNEL_ID).parent_id = null;
    drifted.guild.rules_channel_id = CATEGORY_ID;
    drifted.onboarding.prompts[0].options[0].role_ids = [];
    drifted.automod_rules[0].enabled = false;
    drifted.recent_messages[CHANNEL_ID][0].author.id = '111000111000111000';
    drifted.recent_messages[CHANNEL_ID][0].flags = 0;

    const result = verifyBlueprintSnapshot({
      blueprint: blueprint(),
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      snapshot: drifted,
      guildId: GUILD_ID,
      botId: BOT_ID,
    });
    const codes = result.failures.map((failure) => failure.code);

    expect(result.match).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        'ROLE_MISMATCH',
        'CHANNEL_MISMATCH',
        'GUILD_MISMATCH',
        'ONBOARDING_MISMATCH',
        'AUTOMOD_RULE_MISMATCH',
        'PUBLICATION_AUTHOR_MISMATCH',
        'PUBLICATION_FLAGS_MISMATCH',
      ]),
    );
  });

  it('fails closed on incomplete or duplicate bindings', () => {
    const missing = bindings();
    delete missing.channels.rules;
    expect(() =>
      verifyBlueprintSnapshot({
        blueprint: blueprint(),
        blueprintId: BLUEPRINT_ID,
        bindings: missing,
        snapshot: snapshot(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).toThrow('binding');

    const duplicate = bindings();
    duplicate.channels.rules = ROLE_ID;
    expect(() =>
      verifyBlueprintSnapshot({
        blueprint: blueprint(),
        blueprintId: BLUEPRINT_ID,
        bindings: duplicate,
        snapshot: snapshot(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).toThrow('duplicate');
  });
});
