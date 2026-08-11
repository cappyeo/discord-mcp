import { describe, expect, it } from 'vitest';
import { snapshotFingerprint, snapshotSecurityView } from './snapshot-fingerprint.mjs';

function snapshot() {
  return {
    guild: {
      id: '999000999000999000',
      name: 'Benchmark',
      description: null,
      features: [],
      preferred_locale: 'en-US',
      verification_level: 0,
      default_message_notifications: 1,
      explicit_content_filter: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
      approximate_member_count: 2,
      approximate_presence_count: 1,
    },
    bot: {
      user: { id: '888000888000888000', username: 'Bot' },
      roles: ['777000777000777000'],
      joined_at: '2026-01-01T00:00:00.000Z',
    },
    roles: [
      {
        id: '777000777000777000',
        name: 'Bot',
        permissions: '8',
        position: 10,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: true,
      },
    ],
    channels: [
      {
        id: '666000666000666000',
        guild_id: '999000999000999000',
        name: 'canary',
        type: 0,
        position: 0,
        parent_id: null,
        topic: null,
        nsfw: false,
        rate_limit_per_user: 0,
        permission_overwrites: [],
        available_tags: [],
      },
    ],
    automod_rules: [],
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    publication_history_complete: {},
  };
}

describe('snapshotFingerprint', () => {
  it('ignores volatile guild counts and member timestamps', () => {
    const before = snapshot();
    const after = structuredClone(before);
    after.guild.approximate_member_count = 99;
    after.bot.joined_at = '2030-01-01T00:00:00.000Z';

    expect(snapshotFingerprint(after)).toBe(snapshotFingerprint(before));
  });

  it('ignores Discord-computed onboarding requirements but retains onboarding configuration', () => {
    const before = snapshot();
    before.onboarding = {
      guild_id: before.guild.id,
      prompts: [],
      default_channel_ids: [],
      enabled: false,
      mode: 0,
      below_requirements: false,
    };
    const computedChange = structuredClone(before);
    computedChange.onboarding.below_requirements = true;
    expect(snapshotFingerprint(computedChange)).toBe(snapshotFingerprint(before));

    const configurationChange = structuredClone(before);
    configurationChange.onboarding.enabled = true;
    expect(snapshotFingerprint(configurationChange)).not.toBe(snapshotFingerprint(before));
  });

  it('is stable across response ordering but sensitive to security state', () => {
    const before = snapshot();
    const reordered = structuredClone(before);
    reordered.roles.reverse();
    reordered.bot.roles.reverse();
    expect(snapshotFingerprint(reordered)).toBe(snapshotFingerprint(before));

    const changed = structuredClone(before);
    changed.roles[0].permissions = '0';
    expect(snapshotFingerprint(changed)).not.toBe(snapshotFingerprint(before));
  });

  it('returns a bounded security view without raw transient fields', () => {
    const view = snapshotSecurityView(snapshot());

    expect(view.guild).not.toHaveProperty('approximate_member_count');
    expect(view.bot).not.toHaveProperty('joined_at');
    expect(snapshotFingerprint(snapshot())).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('detects security-relevant fields that used to be omitted', () => {
    const mutations = [
      ['role tags', (value) => (value.roles[0].tags = { bot_id: '888000888000888000' })],
      ['role flags', (value) => (value.roles[0].flags = 1)],
      ['role icon', (value) => (value.roles[0].icon = 'abcdef')],
      ['role unicode emoji', (value) => (value.roles[0].unicode_emoji = '🎮')],
      ['channel flags', (value) => (value.channels[0].flags = 16)],
      [
        'forum metadata',
        (value) => {
          value.channels[0].default_thread_rate_limit_per_user = 10;
          value.channels[0].default_forum_layout = 1;
          value.channels[0].default_sort_order = 0;
        },
      ],
      [
        'automod metadata',
        (value) => {
          value.automod_rules = [
            {
              id: '555000555000555000',
              guild_id: value.guild.id,
              name: 'mentions',
              event_type: 1,
              trigger_type: 5,
              trigger_metadata: { mention_total_limit: 3 },
              actions: [{ type: 1 }],
              enabled: true,
              exempt_roles: [],
              exempt_channels: [],
            },
          ];
        },
      ],
      [
        'onboarding metadata',
        (value) => (value.onboarding = { guild_id: value.guild.id, enabled: true }),
      ],
      [
        'welcome metadata',
        (value) =>
          (value.welcome_screen = { enabled: true, description: 'Welcome!', welcome_channels: [] }),
      ],
      [
        'message attachments embeds stickers',
        (value) => {
          value.recent_messages = {
            [value.channels[0].id]: [
              {
                id: '444000444000444000',
                channel_id: value.channels[0].id,
                guild_id: value.guild.id,
                author: { id: value.bot.user.id, username: 'Bot' },
                content: 'hello',
                attachments: [{ id: '443000443000443000', filename: 'clip.mp4' }],
                embeds: [{ title: 'Build' }],
                stickers: [{ id: '442000442000442000', name: 'gg' }],
              },
            ],
          };
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const changed = structuredClone(snapshot());
      mutate(changed);
      expect(snapshotFingerprint(changed), label).not.toBe(snapshotFingerprint(snapshot()));
    }
  });

  it('is stable when resources, overwrites, tags, and messages are reordered', () => {
    const before = snapshot();
    before.roles.push({
      id: '778000778000778000',
      name: 'Member',
      permissions: '0',
      position: 1,
      color: 0,
      hoist: false,
      mentionable: false,
      managed: false,
      tags: { subscription_listing_id: '123' },
    });
    before.channels[0].permission_overwrites = [
      { id: '778000778000778000', type: 0, allow: '1', deny: '0' },
      { id: '777000777000777000', type: 1, allow: '0', deny: '2' },
    ];
    before.channels[0].available_tags = [
      { id: '2', name: 'clips', moderated: false },
      { id: '1', name: 'guides', moderated: true },
    ];
    before.recent_messages = {
      [before.channels[0].id]: [
        { id: '2', channel_id: before.channels[0].id, guild_id: before.guild.id, content: 'two' },
        { id: '1', channel_id: before.channels[0].id, guild_id: before.guild.id, content: 'one' },
      ],
    };

    const reordered = structuredClone(before);
    reordered.roles.reverse();
    reordered.channels[0].permission_overwrites.reverse();
    reordered.channels[0].available_tags.reverse();
    reordered.recent_messages[reordered.channels[0].id].reverse();
    expect(snapshotFingerprint(reordered)).toBe(snapshotFingerprint(before));
  });

  it('excludes only documented volatile fields', () => {
    const before = snapshot();
    before.channels[0].last_message_id = '123';
    before.channels[0].message_count = 1;
    before.channels[0].thread_metadata = { archived: false, archive_timestamp: 'old' };
    before.recent_messages = {
      [before.channels[0].id]: [
        {
          id: '444000444000444000',
          channel_id: before.channels[0].id,
          guild_id: before.guild.id,
          content: 'hello',
          timestamp: '2026-01-01T00:00:00.000Z',
          edited_timestamp: null,
        },
      ],
    };
    const after = structuredClone(before);
    after.channels[0].last_message_id = '999';
    after.channels[0].message_count = 2;
    after.channels[0].thread_metadata.archive_timestamp = 'new';
    after.recent_messages[before.channels[0].id][0].timestamp = '2026-02-01T00:00:00.000Z';
    after.recent_messages[before.channels[0].id][0].edited_timestamp = '2026-02-01T00:00:00.000Z';
    expect(snapshotFingerprint(after)).toBe(snapshotFingerprint(before));
  });
});
