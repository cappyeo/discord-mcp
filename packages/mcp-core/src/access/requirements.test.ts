import { describe, expect, it } from 'vitest';
import {
  auditToolAccessCoverage,
  getToolAccessRequirement,
  listKnownToolAccessRequirements,
  resolveToolAccessRequirement,
} from './requirements.js';

describe('tool access requirements', () => {
  it('returns typed guild permission requirements', () => {
    expect(getToolAccessRequirement('roles_modify')).toEqual({
      toolName: 'roles_modify',
      status: 'known',
      requirement: {
        auth: 'bot',
        permissions: ['MANAGE_ROLES'],
        intents: [],
        scope: 'guild',
        hierarchy: 'required',
      },
    });
  });

  it('distinguishes channel permissions from guild permissions', () => {
    expect(getToolAccessRequirement('messages_delete').requirement).toMatchObject({
      auth: 'bot',
      permissions: ['MANAGE_MESSAGES'],
      scope: 'channel',
      hierarchy: 'not_applicable',
    });
    expect(getToolAccessRequirement('channels_create_guild_channel').requirement).toMatchObject({
      auth: 'bot',
      permissions: ['MANAGE_CHANNELS'],
      scope: 'guild',
    });
  });

  it('marks message-content readers as requiring the privileged MESSAGE_CONTENT intent', () => {
    for (const toolName of [
      'messages_get',
      'messages_read',
      'messages_search_recent',
      'messages_list_pins',
      'intelligence_summarize_channel',
      'intelligence_classify_messages',
      'intelligence_draft_response',
      'intelligence_extract_entities',
    ]) {
      expect(getToolAccessRequirement(toolName).requirement).toMatchObject({
        scope: 'channel',
        intents: ['MESSAGE_CONTENT'],
      });
    }
    for (const toolName of [
      'reactions_list',
      'polls_get_voters',
      'threads_get_member',
      'channels_list_public_archived_threads',
      'channels_list_joined_private_archived_threads',
    ]) {
      expect(getToolAccessRequirement(toolName).requirement?.intents).toEqual([]);
    }
    expect(
      getToolAccessRequirement('channels_list_private_archived_threads').requirement,
    ).toMatchObject({
      permissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'MANAGE_THREADS'],
      intents: [],
    });
  });

  it('declares the target field and cross-guild semantics for announcement follows', () => {
    expect(getToolAccessRequirement('channels_follow_announcement').requirement).toMatchObject({
      permissionTargetFields: ['webhook_channel_id'],
      allowCrossGuild: true,
    });
  });

  it('declares privileged Gateway intent requirements separately', () => {
    expect(getToolAccessRequirement('members_list').requirement).toEqual({
      auth: 'bot',
      permissions: [],
      intents: ['GUILD_MEMBERS'],
      scope: 'guild',
      hierarchy: 'not_applicable',
    });
    expect(getToolAccessRequirement('threads_list_members').requirement?.intents).toEqual([
      'GUILD_MEMBERS',
    ]);
  });

  it('returns explicit unknown status for tools without a catalogued requirement', () => {
    expect(getToolAccessRequirement('new_future_tool')).toEqual({
      toolName: 'new_future_tool',
      status: 'unknown',
      requirement: null,
    });
    expect(resolveToolAccessRequirement('new_future_tool', {})).toBeNull();
  });

  it('models bot application scope for application emoji operations', () => {
    expect(getToolAccessRequirement('app_emojis_create').requirement).toEqual({
      auth: 'bot',
      permissions: [],
      intents: [],
      scope: 'bot_application',
      hierarchy: 'not_applicable',
    });
  });

  it('models DM creation as a user-scoped route separate from consent', () => {
    expect(getToolAccessRequirement('users_create_dm')).toEqual({
      toolName: 'users_create_dm',
      status: 'known',
      requirement: {
        auth: 'bot',
        permissions: [],
        intents: [],
        scope: 'user',
        hierarchy: 'not_applicable',
      },
    });
  });

  it('models message send prerequisites and bearer-only command permission edits', () => {
    expect(getToolAccessRequirement('messages_send').requirement).toMatchObject({
      auth: 'bot',
      permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      scope: 'channel',
    });
    expect(getToolAccessRequirement('commands_edit_command_permissions').requirement).toEqual({
      auth: 'bearer',
      permissions: ['MANAGE_GUILD'],
      intents: [],
      scope: 'guild',
      hierarchy: 'not_applicable',
    });
  });

  it('matches Discord permissions for prune, onboarding, and stage voice routes', () => {
    expect(getToolAccessRequirement('guild_get_prune_count').requirement?.permissions).toEqual([
      'MANAGE_GUILD',
      'KICK_MEMBERS',
    ]);
    expect(getToolAccessRequirement('guild_begin_prune').requirement?.permissions).toEqual([
      'MANAGE_GUILD',
      'KICK_MEMBERS',
    ]);
    expect(getToolAccessRequirement('onboarding_modify').requirement?.permissions).toEqual([
      'MANAGE_GUILD',
      'MANAGE_ROLES',
    ]);
    expect(getToolAccessRequirement('guild_modify_user_voice_state').requirement).toMatchObject({
      permissions: ['MUTE_MEMBERS'],
      hierarchy: 'required',
    });
    expect(getToolAccessRequirement('members_bulk_ban').requirement?.permissions).toEqual([
      'BAN_MEMBERS',
      'MANAGE_GUILD',
    ]);
  });

  it('tracks Discord 2026 split permissions and channel-specific media requirements', () => {
    for (const toolName of [
      'emojis_create',
      'stickers_create_guild_sticker',
      'soundboard_create_guild_sound',
    ]) {
      expect(getToolAccessRequirement(toolName).requirement?.permissions).toEqual([
        'CREATE_GUILD_EXPRESSIONS',
      ]);
    }
    expect(getToolAccessRequirement('events_create').requirement?.permissions).toEqual([
      'CREATE_EVENTS',
    ]);
    expect(resolveToolAccessRequirement('events_create', { entity_type: 1 })?.permissions).toEqual([
      'CREATE_EVENTS',
      'MANAGE_CHANNELS',
      'MUTE_MEMBERS',
      'MOVE_MEMBERS',
    ]);
    expect(resolveToolAccessRequirement('events_create', { entity_type: 2 })?.permissions).toEqual([
      'CREATE_EVENTS',
      'VIEW_CHANNEL',
      'CONNECT',
    ]);
    expect(resolveToolAccessRequirement('events_create', { entity_type: 3 })?.permissions).toEqual([
      'CREATE_EVENTS',
    ]);
    expect(getToolAccessRequirement('guild_get_vanity_url').requirement?.permissions).toEqual([
      'MANAGE_GUILD',
    ]);
    expect(getToolAccessRequirement('guild_get_widget_settings').requirement?.permissions).toEqual([
      'MANAGE_GUILD',
    ]);
    expect(getToolAccessRequirement('stage_instances_create').requirement?.permissions).toEqual([
      'VIEW_CHANNEL',
      'MANAGE_CHANNELS',
      'MUTE_MEMBERS',
      'MOVE_MEMBERS',
    ]);
    expect(
      resolveToolAccessRequirement('soundboard_send_sound', { sound_id: '1' })?.permissions,
    ).toEqual(['VIEW_CHANNEL', 'SPEAK', 'USE_SOUNDBOARD']);
    expect(
      resolveToolAccessRequirement('soundboard_send_sound', {
        sound_id: '1',
        source_guild_id: '999000999000999000',
      })?.permissions,
    ).toEqual(['VIEW_CHANNEL', 'SPEAK', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS']);
  });

  it('tracks the post-February-2026 pin permission and thread send prerequisite', () => {
    expect(getToolAccessRequirement('messages_pin').requirement?.permissions).toEqual([
      'PIN_MESSAGES',
    ]);
    expect(getToolAccessRequirement('messages_unpin').requirement?.permissions).toEqual([
      'PIN_MESSAGES',
    ]);
    expect(
      getToolAccessRequirement('channels_forum_create_thread').requirement?.permissions,
    ).toEqual(['VIEW_CHANNEL', 'SEND_MESSAGES']);
    expect(getToolAccessRequirement('threads_add_member').requirement?.permissions).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES_IN_THREADS',
    ]);
    expect(getToolAccessRequirement('messages_create_thread').requirement?.permissions).toEqual([
      'VIEW_CHANNEL',
      'CREATE_PUBLIC_THREADS',
    ]);
    expect(getToolAccessRequirement('invites_list_channel').requirement?.permissions).toEqual([
      'VIEW_CHANNEL',
      'MANAGE_CHANNELS',
    ]);
    expect(getToolAccessRequirement('events_list_users').requirement?.intents).toEqual([]);
    expect(getToolAccessRequirement('members_search').requirement?.intents).toEqual([]);
  });

  it('resolves current stage voice permissions by requested operation', () => {
    expect(
      resolveToolAccessRequirement('guild_modify_current_voice_state', { suppress: true }),
    ).toBeNull();
    expect(
      resolveToolAccessRequirement('guild_modify_current_voice_state', { suppress: false }),
    ).toMatchObject({
      permissions: ['MUTE_MEMBERS'],
    });
    expect(
      resolveToolAccessRequirement('guild_modify_current_voice_state', {
        request_to_speak_timestamp: '2026-08-28T00:00:00.000Z',
      }),
    ).toMatchObject({ permissions: ['REQUEST_TO_SPEAK'] });
    expect(
      resolveToolAccessRequirement('guild_modify_current_voice_state', {
        request_to_speak_timestamp: null,
      }),
    ).toMatchObject({ permissions: [] });
    expect(
      resolveToolAccessRequirement('guild_modify_current_voice_state', { channel_id: '1' }),
    ).toMatchObject({
      permissions: [],
    });
  });

  it('models channel write access for Components V2 operations', () => {
    for (const toolName of [
      'components_v2_send',
      'components_v2_edit',
      'components_v2_send_from_template',
    ]) {
      expect(getToolAccessRequirement(toolName)).toMatchObject({
        status: 'known',
        requirement: {
          auth: 'bot',
          permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
          scope: 'channel',
        },
      });
    }
  });

  it('keeps local, external, and opaque-token routes out of bot permission checks', () => {
    expect(getToolAccessRequirement('components_v2_validate').requirement).toMatchObject({
      auth: 'none',
      scope: 'local',
    });
    expect(getToolAccessRequirement('inspiration_emoji_gg_search').requirement).toMatchObject({
      auth: 'none',
      scope: 'external',
    });
    expect(getToolAccessRequirement('interactions_create_response').requirement).toMatchObject({
      auth: 'opaque',
      scope: 'external',
    });
  });

  it('marks the blueprint lifecycle as delegated to its stronger internal verifier', () => {
    expect(getToolAccessRequirement('guild_blueprint_apply')).toMatchObject({
      status: 'known',
      requirement: { scope: 'guild', verification: 'delegated' },
    });
  });

  it('resolves members_modify permissions from the fields that will actually change', () => {
    expect(resolveToolAccessRequirement('members_modify', { nick: 'mod' })).toMatchObject({
      permissions: ['MANAGE_NICKNAMES'],
      hierarchy: 'required',
    });
    expect(resolveToolAccessRequirement('members_modify', { roles: [] })).toMatchObject({
      permissions: ['MANAGE_ROLES'],
      hierarchy: 'required',
    });
    expect(resolveToolAccessRequirement('members_modify', { channel_id: '1' })).toMatchObject({
      permissions: ['MOVE_MEMBERS', 'CONNECT'],
      hierarchy: 'required',
    });
    expect(resolveToolAccessRequirement('members_modify', { channel_id: null })).toMatchObject({
      permissions: ['MOVE_MEMBERS'],
      hierarchy: 'required',
    });
    expect(
      resolveToolAccessRequirement('members_modify', {
        mute: true,
        communication_disabled_until: null,
      }),
    ).toMatchObject({
      permissions: ['MUTE_MEMBERS', 'MODERATE_MEMBERS'],
      hierarchy: 'required',
    });
    expect(resolveToolAccessRequirement('members_modify', { audit_reason: 'only' })).toBeNull();
    expect(getToolAccessRequirement('members_modify').requirement?.permissions).toEqual([]);
  });

  it('keeps conditional contracts non-hierarchical when no condition requires hierarchy', () => {
    const requirement = {
      auth: 'bot' as const,
      permissions: [] as const,
      intents: [] as const,
      scope: 'guild' as const,
      hierarchy: 'not_applicable' as const,
      conditions: [{ fields: ['enabled'], permissions: ['MANAGE_GUILD'] as const }],
      requireConditionMatch: true as const,
    };
    expect(resolveToolAccessRequirement('synthetic', { enabled: true }, requirement)).toMatchObject(
      {
        permissions: ['MANAGE_GUILD'],
        hierarchy: 'not_applicable',
      },
    );
  });

  it('fails closed for non-object conditional input and reports unknown coverage explicitly', () => {
    expect(resolveToolAccessRequirement('members_modify', null)).toBeNull();
    expect(
      auditToolAccessCoverage([{ name: 'messages_send' }, { name: 'future_tool' }]),
    ).toMatchObject({
      total: 2,
      known: 1,
      registryFallback: 1,
      unknown: 1,
    });
  });

  it('does not expose mutable registry internals through the listing API', () => {
    const listed = listKnownToolAccessRequirements();
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.some((entry) => entry.toolName === 'audit_log_get')).toBe(true);
    expect(listed.every((entry) => entry.status === 'known')).toBe(true);
    const messages = listed.find((entry) => entry.toolName === 'messages_send');
    expect(messages?.requirement?.permissions).toEqual(['VIEW_CHANNEL', 'SEND_MESSAGES']);
    (messages?.requirement?.permissions as string[] | undefined)?.push('BAN_MEMBERS');
    expect(getToolAccessRequirement('messages_send').requirement?.permissions).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
    ]);
  });
});
