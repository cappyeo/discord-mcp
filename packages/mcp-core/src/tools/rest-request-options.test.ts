import type { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from '../pieces/Tool.js';
import AutoModCreate from './automod/create_rule.js';
import ForumCreate from './channels/forum_create_thread.js';
import JoinedArchived from './channels/list_joined_private_archived_threads.js';
import PrivateArchived from './channels/list_private_archived_threads.js';
import PublicArchived from './channels/list_public_archived_threads.js';
import EventsCreate from './events/create.js';
import EventUsers from './events/list_users.js';
import VoiceModify from './guild/modify_current_voice_state.js';
import WelcomeModify from './guild/modify_welcome_screen.js';
import WidgetModify from './guild/modify_widget.js';
import InviteCreate from './invites/create_channel.js';
import InviteGet from './invites/get.js';
import BansList from './members/list_bans.js';
import EntitlementsList from './monetization/entitlements_list.js';
import SubscriptionsList from './monetization/subscriptions_list.js';
import PollVoters from './polls/get_voters.js';
import ReactionsList from './reactions/list.js';
import SoundCreate from './soundboard/create_guild_sound.js';
import SoundModify from './soundboard/modify_guild_sound.js';
import StageCreate from './stage_instances/create.js';
import StageModify from './stage_instances/modify.js';
import ThreadMembers from './threads/list_members.js';
import UserGuilds from './users/list_current_user_guilds.js';
import UserModify from './users/modify_current.js';
import WebhookModify from './webhooks/modify.js';
import '../container.js';

const GUILD = '111122223333444455';
const CHANNEL = '222233334444555566';
const USER = '333344445555666677';
const ITEM = '444455556666777788';
const CURSOR = '555566667777888899';
const DATE = '2026-10-01T12:00:00Z';

function instance(Definition: typeof Tool): Tool {
  const Concrete = Definition as new (...args: ConstructorParameters<typeof Tool>) => Tool;
  return new Concrete(
    { name: Definition.name, path: 'inline', root: 'inline', store: null as never },
    { name: Definition.name, enabled: true },
  );
}

interface QueryCase {
  Tool: typeof Tool;
  args: Record<string, unknown>;
  route: string;
  query: Record<string, string>;
  response: unknown;
}

const queryCases: QueryCase[] = [
  ...(['before', 'after'] as const).flatMap((cursor) => [
    {
      Tool: EntitlementsList,
      args: {
        application_id: ITEM,
        user_id: USER,
        sku_ids: [ITEM, CURSOR],
        [cursor]: CURSOR,
        limit: 2,
        guild_id: GUILD,
        exclude_ended: cursor === 'before',
        exclude_deleted: cursor !== 'before',
      },
      route: `/applications/${ITEM}/entitlements`,
      query: {
        user_id: USER,
        sku_ids: `${ITEM},${CURSOR}`,
        [cursor]: CURSOR,
        limit: '2',
        guild_id: GUILD,
        exclude_ended: String(cursor === 'before'),
        exclude_deleted: String(cursor !== 'before'),
      },
      response: [],
    },
    {
      Tool: SubscriptionsList,
      args: { sku_id: ITEM, user_id: USER, [cursor]: CURSOR, limit: 2 },
      route: `/skus/${ITEM}/subscriptions`,
      query: { user_id: USER, [cursor]: CURSOR, limit: '2' },
      response: [],
    },
    {
      Tool: BansList,
      args: { guild_id: GUILD, [cursor]: CURSOR, limit: 2 },
      route: `/guilds/${GUILD}/bans`,
      query: { [cursor]: CURSOR, limit: '2' },
      response: [],
    },
    {
      Tool: EventUsers,
      args: { guild_id: GUILD, event_id: ITEM, [cursor]: CURSOR, limit: 2, with_member: false },
      route: `/guilds/${GUILD}/scheduled-events/${ITEM}/users`,
      query: { [cursor]: CURSOR, limit: '2', with_member: 'false' },
      response: [],
    },
    {
      Tool: UserGuilds,
      args: { [cursor]: CURSOR, limit: 2, with_counts: false },
      route: '/users/@me/guilds',
      query: { [cursor]: CURSOR, limit: '2', with_counts: 'false' },
      response: [],
    },
  ]),
  {
    Tool: ThreadMembers,
    args: { thread_id: CHANNEL, after: CURSOR, limit: 2, with_member: true },
    route: `/channels/${CHANNEL}/thread-members`,
    query: { after: CURSOR, limit: '2', with_member: 'true' },
    response: [],
  },
  {
    Tool: JoinedArchived,
    args: { channel_id: CHANNEL, before: CURSOR, limit: 2 },
    route: `/channels/${CHANNEL}/users/@me/threads/archived/private`,
    query: { before: CURSOR, limit: '2' },
    response: { threads: [] },
  },
  ...(
    [
      ['private', PrivateArchived],
      ['public', PublicArchived],
    ] as const
  ).map(([kind, Tool]) => ({
    Tool,
    args: { channel_id: CHANNEL, before: DATE, limit: 2 },
    route: `/channels/${CHANNEL}/threads/archived/${kind}`,
    query: { before: DATE, limit: '2' },
    response: { threads: [] },
  })),
  {
    Tool: PollVoters,
    args: { channel_id: CHANNEL, message_id: ITEM, answer_id: 1, after: CURSOR, limit: 2 },
    route: `/channels/${CHANNEL}/polls/${ITEM}/answers/1`,
    query: { after: CURSOR, limit: '2' },
    response: { users: [] },
  },
  {
    Tool: ReactionsList,
    args: {
      channel_id: CHANNEL,
      message_id: ITEM,
      emoji: 'wave',
      after: CURSOR,
      limit: 2,
      type: 1,
    },
    route: `/channels/${CHANNEL}/messages/${ITEM}/reactions/wave`,
    query: { after: CURSOR, limit: '2', type: '1' },
    response: [],
  },
  {
    Tool: InviteGet,
    args: {
      code: 'example',
      with_counts: false,
      with_expiration: true,
      guild_scheduled_event_id: ITEM,
    },
    route: '/invites/example',
    query: { with_counts: 'false', with_expiration: 'true', guild_scheduled_event_id: ITEM },
    response: { code: 'example' },
  },
];

describe('Discord query option contracts', () => {
  it.each(queryCases)('$Tool.name forwards supplied filters and pagination', async (testCase) => {
    const get = vi.fn().mockResolvedValue(testCase.response);
    container.rest = { get } as unknown as REST;
    const tool = instance(testCase.Tool);
    const result = await tool.run(z.object(tool.inputSchema).parse(testCase.args), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ isError: false });
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0]).toBe(testCase.route);
    expect(Object.fromEntries(get.mock.calls[0]![1].query)).toEqual(testCase.query);
  });
});

interface BodyCase {
  Tool: typeof Tool;
  method: 'post' | 'patch';
  args: Record<string, unknown>;
  route: string;
  body: Record<string, unknown>;
  response: unknown;
}

const welcomeChannels = [
  { channel_id: CHANNEL, description: 'Start here', emoji_id: null, emoji_name: '👋' },
];
const sound = { sound_id: ITEM, name: 'Welcome', volume: 0, emoji_id: null, emoji_name: '👋' };
const stage = {
  id: ITEM,
  guild_id: GUILD,
  channel_id: CHANNEL,
  topic: 'Town hall',
  privacy_level: 2,
};
const bodyCases: BodyCase[] = [
  {
    Tool: AutoModCreate,
    method: 'post',
    route: `/guilds/${GUILD}/auto-moderation/rules`,
    args: {
      guild_id: GUILD,
      name: 'Keywords',
      event_type: 1,
      trigger_type: 1,
      actions: [{ type: 1 }],
      trigger_metadata: { keyword_filter: ['spam'] },
      enabled: false,
      exempt_roles: [ITEM],
      exempt_channels: [CHANNEL],
    },
    body: {
      name: 'Keywords',
      event_type: 1,
      trigger_type: 1,
      actions: [{ type: 1 }],
      trigger_metadata: { keyword_filter: ['spam'] },
      enabled: false,
      exempt_roles: [ITEM],
      exempt_channels: [CHANNEL],
    },
    response: { id: ITEM, name: 'Keywords', trigger_type: 1, enabled: false },
  },
  {
    Tool: ForumCreate,
    method: 'post',
    route: `/channels/${CHANNEL}/threads`,
    args: {
      channel_id: CHANNEL,
      name: 'Help',
      message: { content: 'Question' },
      auto_archive_duration: 60,
      rate_limit_per_user: 0,
      applied_tags: [ITEM],
    },
    body: {
      name: 'Help',
      message: { content: 'Question' },
      auto_archive_duration: 60,
      rate_limit_per_user: 0,
      applied_tags: [ITEM],
    },
    response: { id: CURSOR, parent_id: CHANNEL, message: { id: ITEM } },
  },
  {
    Tool: EventsCreate,
    method: 'post',
    route: `/guilds/${GUILD}/scheduled-events`,
    args: {
      guild_id: GUILD,
      name: 'Meetup',
      scheduled_start_time: DATE,
      scheduled_end_time: '2026-10-01T13:00:00Z',
      entity_type: 3,
      entity_metadata: { location: 'Online' },
      description: 'Monthly meetup',
      image: 'data:image/png;base64,AA==',
      recurrence_rule: { start: DATE, frequency: 2, interval: 1 },
    },
    body: {
      name: 'Meetup',
      privacy_level: 2,
      scheduled_start_time: DATE,
      scheduled_end_time: '2026-10-01T13:00:00Z',
      entity_type: 3,
      entity_metadata: { location: 'Online' },
      description: 'Monthly meetup',
      image: 'data:image/png;base64,AA==',
      recurrence_rule: { start: DATE, frequency: 2, interval: 1 },
    },
    response: {
      id: ITEM,
      guild_id: GUILD,
      name: 'Meetup',
      scheduled_start_time: DATE,
      scheduled_end_time: null,
      status: 1,
      entity_type: 3,
      channel_id: null,
    },
  },
  {
    Tool: InviteCreate,
    method: 'post',
    route: `/channels/${CHANNEL}/invites`,
    args: { channel_id: CHANNEL, temporary: false, target_type: 1, target_user_id: USER },
    body: { temporary: false, target_type: 1, target_user_id: USER },
    response: { code: 'stream-invite' },
  },
  {
    Tool: InviteCreate,
    method: 'post',
    route: `/channels/${CHANNEL}/invites`,
    args: { channel_id: CHANNEL, target_type: 2, target_application_id: ITEM },
    body: { target_type: 2, target_application_id: ITEM },
    response: { code: 'activity-invite' },
  },
  {
    Tool: SoundCreate,
    method: 'post',
    route: `/guilds/${GUILD}/soundboard-sounds`,
    args: {
      guild_id: GUILD,
      name: 'Welcome',
      sound: 'data:audio/mpeg;base64,AA==',
      volume: 0,
      emoji_id: ITEM,
      emoji_name: '👋',
    },
    body: {
      name: 'Welcome',
      sound: 'data:audio/mpeg;base64,AA==',
      volume: 0,
      emoji_id: ITEM,
      emoji_name: '👋',
    },
    response: sound,
  },
  {
    Tool: SoundModify,
    method: 'patch',
    route: `/guilds/${GUILD}/soundboard-sounds/${ITEM}`,
    args: { guild_id: GUILD, sound_id: ITEM, volume: 0, emoji_id: null, emoji_name: '👋' },
    body: { volume: 0, emoji_id: null, emoji_name: '👋' },
    response: sound,
  },
  {
    Tool: WelcomeModify,
    method: 'patch',
    route: `/guilds/${GUILD}/welcome-screen`,
    args: { guild_id: GUILD, enabled: false, welcome_channels: welcomeChannels, description: null },
    body: { enabled: false, welcome_channels: welcomeChannels, description: null },
    response: { description: null, welcome_channels: welcomeChannels },
  },
  {
    Tool: WidgetModify,
    method: 'patch',
    route: `/guilds/${GUILD}/widget`,
    args: { guild_id: GUILD, enabled: false, channel_id: null },
    body: { enabled: false, channel_id: null },
    response: { enabled: false, channel_id: null },
  },
  {
    Tool: VoiceModify,
    method: 'patch',
    route: `/guilds/${GUILD}/voice-states/%40me`,
    args: {
      guild_id: GUILD,
      channel_id: CHANNEL,
      suppress: false,
      request_to_speak_timestamp: null,
    },
    body: { channel_id: CHANNEL, suppress: false, request_to_speak_timestamp: null },
    response: undefined,
  },
  {
    Tool: StageCreate,
    method: 'post',
    route: '/stage-instances',
    args: {
      channel_id: CHANNEL,
      topic: 'Town hall',
      privacy_level: 2,
      send_start_notification: false,
      guild_scheduled_event_id: ITEM,
    },
    body: {
      channel_id: CHANNEL,
      topic: 'Town hall',
      privacy_level: 2,
      send_start_notification: false,
      guild_scheduled_event_id: ITEM,
    },
    response: stage,
  },
  {
    Tool: StageModify,
    method: 'patch',
    route: `/stage-instances/${CHANNEL}`,
    args: { channel_id: CHANNEL, privacy_level: 2 },
    body: { privacy_level: 2 },
    response: stage,
  },
  {
    Tool: UserModify,
    method: 'patch',
    route: '/users/%40me',
    args: { avatar: null, banner: null },
    body: { avatar: null, banner: null },
    response: { id: USER, username: 'Bot', global_name: null, avatar: null },
  },
  {
    Tool: WebhookModify,
    method: 'patch',
    route: `/webhooks/${ITEM}`,
    args: { webhook_id: ITEM, avatar: null, channel_id: CHANNEL },
    body: { avatar: null, channel_id: CHANNEL },
    response: {
      id: ITEM,
      type: 1,
      name: null,
      avatar: null,
      channel_id: CHANNEL,
      application_id: null,
    },
  },
];

describe('Discord optional request body contracts', () => {
  it.each(
    bodyCases,
  )('$Tool.name preserves explicit false, zero, null, and optional fields', async (testCase) => {
    const request = vi.fn().mockResolvedValue(testCase.response);
    container.rest = { [testCase.method]: request } as unknown as REST;
    const tool = instance(testCase.Tool);
    const result = await tool.run(z.object(tool.inputSchema).parse(testCase.args), {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ isError: false });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe(testCase.route);
    expect(request.mock.calls[0]![1].body).toEqual(testCase.body);
  });
});
