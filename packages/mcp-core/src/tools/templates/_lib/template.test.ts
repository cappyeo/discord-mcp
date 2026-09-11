import { describe, expect, it } from 'vitest';
import { type RawGuildTemplate, templateCodeFromReference, templateDrift } from './template.js';

const base: RawGuildTemplate = {
  code: 'test',
  name: 'Test',
  description: null,
  usage_count: 0,
  creator_id: '100000000000000001',
  source_guild_id: '100000000000000002',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  is_dirty: false,
  serialized_source_guild: { channels: [], roles: [] },
};

describe('template drift edge cases', () => {
  it('rejects text that is neither a code nor a URL', () => {
    expect(() => templateCodeFromReference('not a template URL')).toThrow(
      'Template reference must be',
    );
  });

  it('counts missing duplicate channels and pairs matching permissions despite API ordering', () => {
    const roles = [
      { id: '0', name: '@everyone', permissions: '0' },
      { id: '1', name: 'Member', permissions: '1' },
      { id: '2', name: 'Member', permissions: '2' },
    ];
    const channels = [
      { name: 'general', type: 0 },
      { name: 'general', type: 0 },
    ];
    const result = templateDrift(
      { ...base, serialized_source_guild: { channels, roles } },
      [channels[0]!],
      [roles[0]!, roles[2]!, roles[1]!],
    );
    expect(result.drift).toMatchObject({
      channels_missing_from_guild_count: 1,
      role_permission_difference_count: 0,
      sync_recommended: true,
    });
  });

  it('compares forum tags independent of order and records unmapped overwrites', () => {
    const tags = [
      { id: '1', name: 'A' },
      { id: '2', name: 'B', moderated: true },
    ];
    const channel = {
      name: 'forum',
      type: 15,
      available_tags: tags,
      default_reaction_emoji: null,
      permission_overwrites: [
        { id: 'unknown-role', type: 0, allow: '1', deny: '0' },
        { id: '100000000000000003', type: 1, allow: '1', deny: '0' },
      ],
    };
    const roles = [{ name: 'No ID', permissions: '0' }];
    const template = { ...base, serialized_source_guild: { channels: [channel], roles } };
    const same = templateDrift(
      template,
      [{ ...channel, available_tags: [...tags].reverse() }],
      roles,
    );
    expect(same.drift).toMatchObject({
      channel_setting_difference_count: 0,
      permission_overwrite_difference_count: 0,
      unmapped_permission_overwrite_count: 2,
    });
    const changed = templateDrift(
      template,
      [{ ...channel, available_tags: null, default_reaction_emoji: 'unknown' }],
      roles,
    );
    expect(changed.details.channels_with_setting_changes).toEqual([
      { name: 'forum', fields: ['default_reaction_emoji', 'available_tags'] },
    ]);
  });
});
