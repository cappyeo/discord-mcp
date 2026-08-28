import { PermissionFlagsBits } from 'discord-api-types/v10';

/**
 * Machine-readable Discord access requirements for a conservative catalogued
 * subset of tools.
 *
 * This registry is intentionally pure and conservative. An absent entry is
 * represented as `unknown`, rather than meaning that a tool needs no Discord
 * permission. Runtime preflight and tool metadata can adopt this seam without
 * coupling the registry to REST, Gateway, or server lifecycle code.
 */

export const DISCORD_PERMISSION_NAMES = [
  'VIEW_CHANNEL',
  'CREATE_INSTANT_INVITE',
  'SEND_MESSAGES',
  'SEND_MESSAGES_IN_THREADS',
  'READ_MESSAGE_HISTORY',
  'ADD_REACTIONS',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'USE_EXTERNAL_EMOJIS',
  'USE_APPLICATION_COMMANDS',
  'VIEW_AUDIT_LOG',
  'MANAGE_CHANNELS',
  'MANAGE_THREADS',
  'CREATE_PUBLIC_THREADS',
  'CREATE_PRIVATE_THREADS',
  'MANAGE_EVENTS',
  'CREATE_EVENTS',
  'MANAGE_GUILD',
  'MANAGE_MESSAGES',
  'PIN_MESSAGES',
  'MANAGE_NICKNAMES',
  'MANAGE_ROLES',
  'MANAGE_WEBHOOKS',
  'MANAGE_EMOJIS_AND_STICKERS',
  'MANAGE_GUILD_EXPRESSIONS',
  'CREATE_GUILD_EXPRESSIONS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'MODERATE_MEMBERS',
  'MOVE_MEMBERS',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'CONNECT',
  'SPEAK',
  'USE_SOUNDBOARD',
  'USE_EXTERNAL_SOUNDS',
  'SEND_POLLS',
  'CHANGE_NICKNAME',
  'REQUEST_TO_SPEAK',
] as const;

export type DiscordPermissionName = (typeof DISCORD_PERMISSION_NAMES)[number];

/** Permission bit values for the named subset used by the access registry. */
export const DISCORD_PERMISSION_BITS: Readonly<Record<DiscordPermissionName, bigint>> = {
  VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
  CREATE_INSTANT_INVITE: PermissionFlagsBits.CreateInstantInvite,
  SEND_MESSAGES: PermissionFlagsBits.SendMessages,
  SEND_MESSAGES_IN_THREADS: PermissionFlagsBits.SendMessagesInThreads,
  READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
  ADD_REACTIONS: PermissionFlagsBits.AddReactions,
  EMBED_LINKS: PermissionFlagsBits.EmbedLinks,
  ATTACH_FILES: PermissionFlagsBits.AttachFiles,
  USE_EXTERNAL_EMOJIS: PermissionFlagsBits.UseExternalEmojis,
  USE_APPLICATION_COMMANDS: PermissionFlagsBits.UseApplicationCommands,
  VIEW_AUDIT_LOG: PermissionFlagsBits.ViewAuditLog,
  MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
  MANAGE_THREADS: PermissionFlagsBits.ManageThreads,
  CREATE_PUBLIC_THREADS: PermissionFlagsBits.CreatePublicThreads,
  CREATE_PRIVATE_THREADS: PermissionFlagsBits.CreatePrivateThreads,
  MANAGE_EVENTS: PermissionFlagsBits.ManageEvents,
  CREATE_EVENTS: PermissionFlagsBits.CreateEvents,
  MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
  MANAGE_MESSAGES: PermissionFlagsBits.ManageMessages,
  PIN_MESSAGES: PermissionFlagsBits.PinMessages,
  MANAGE_NICKNAMES: PermissionFlagsBits.ManageNicknames,
  MANAGE_ROLES: PermissionFlagsBits.ManageRoles,
  MANAGE_WEBHOOKS: PermissionFlagsBits.ManageWebhooks,
  MANAGE_EMOJIS_AND_STICKERS: PermissionFlagsBits.ManageEmojisAndStickers,
  MANAGE_GUILD_EXPRESSIONS: PermissionFlagsBits.ManageGuildExpressions,
  CREATE_GUILD_EXPRESSIONS: PermissionFlagsBits.CreateGuildExpressions,
  KICK_MEMBERS: PermissionFlagsBits.KickMembers,
  BAN_MEMBERS: PermissionFlagsBits.BanMembers,
  MODERATE_MEMBERS: PermissionFlagsBits.ModerateMembers,
  MOVE_MEMBERS: PermissionFlagsBits.MoveMembers,
  MUTE_MEMBERS: PermissionFlagsBits.MuteMembers,
  DEAFEN_MEMBERS: PermissionFlagsBits.DeafenMembers,
  CONNECT: PermissionFlagsBits.Connect,
  SPEAK: PermissionFlagsBits.Speak,
  USE_SOUNDBOARD: PermissionFlagsBits.UseSoundboard,
  USE_EXTERNAL_SOUNDS: PermissionFlagsBits.UseExternalSounds,
  SEND_POLLS: PermissionFlagsBits.SendPolls,
  CHANGE_NICKNAME: PermissionFlagsBits.ChangeNickname,
  REQUEST_TO_SPEAK: PermissionFlagsBits.RequestToSpeak,
};

export const GATEWAY_INTENT_NAMES = ['GUILD_MEMBERS', 'MESSAGE_CONTENT'] as const;

export type GatewayIntentName = (typeof GATEWAY_INTENT_NAMES)[number];

export type AccessScope =
  | 'global'
  | 'guild'
  | 'channel'
  | 'bot_application'
  | 'user'
  | 'local'
  | 'external';

export type AuthKind = 'bot' | 'bearer' | 'opaque' | 'either' | 'none';

/** Whether this contract proves permissions here or delegates them to a tool's own verifier. */
export type AccessVerification = 'runtime' | 'delegated';

export interface DiscordAccessRequirement {
  readonly auth: AuthKind;
  readonly permissions: readonly DiscordPermissionName[];
  readonly intents: readonly GatewayIntentName[];
  readonly scope: AccessScope;
  readonly hierarchy: 'required' | 'not_applicable';
  readonly verification?: AccessVerification;
  /** Field-triggered requirements for tools with several independent actions. */
  readonly conditions?: readonly AccessCondition[];
  /** If true, a payload with no matching condition is unresolved. */
  readonly requireConditionMatch?: boolean;
  /** Fields that carry the channel(s) whose permissions authorize the route. */
  readonly permissionTargetFields?: readonly string[];
  /** Whether a single operation may intentionally span multiple guilds. */
  readonly allowCrossGuild?: boolean;
}

export interface AccessCondition {
  readonly fields: readonly string[];
  readonly permissions: readonly DiscordPermissionName[];
  readonly hierarchy?: 'required' | 'not_applicable';
  /** Optional exact values for fields that activate this condition. */
  readonly when?: Readonly<Record<string, unknown>>;
  /** Optional fields that must contain a non-null value to activate it. */
  readonly nonNullFields?: readonly string[];
}

export const BOT_APPLICATION_ACCESS = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'bot_application',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

export const BOT_APPLICATION_READ_ACCESS = BOT_APPLICATION_ACCESS;

export const GUILD_READ_ACCESS = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'guild',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

export const CHANNEL_READ_ACCESS = {
  auth: 'bot',
  permissions: ['VIEW_CHANNEL'],
  intents: [],
  scope: 'channel',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

export const CHANNEL_WRITE_ACCESS = {
  auth: 'bot',
  permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
  intents: [],
  scope: 'channel',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** Operations that never contact Discord (builders, validators, and planners). */
export const LOCAL_ACCESS = {
  auth: 'none',
  permissions: [],
  intents: [],
  scope: 'local',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** Read-only external providers whose data is not controlled by the bot. */
export const EXTERNAL_ACCESS = {
  auth: 'none',
  permissions: [],
  intents: [],
  scope: 'external',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** Routes authorized by a short-lived Discord interaction/webhook token. */
export const OPAQUE_TOKEN_ACCESS = {
  auth: 'opaque',
  permissions: [],
  intents: [],
  scope: 'external',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** User-targeted bot routes whose recipient consent is enforced separately. */
export const USER_SCOPED_ACCESS = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'user',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** Public Discord endpoints that still carry an explicit guild target. */
export const PUBLIC_GUILD_ACCESS = {
  auth: 'none',
  permissions: [],
  intents: [],
  scope: 'guild',
  hierarchy: 'not_applicable',
} as const satisfies DiscordAccessRequirement;

/** Blueprint tools perform a stronger target/permission/readback verification internally. */
export const BLUEPRINT_GUILD_ACCESS = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'guild',
  hierarchy: 'not_applicable',
  verification: 'delegated',
} as const satisfies DiscordAccessRequirement;

export interface ToolAccessRequirement {
  readonly toolName: string;
  readonly status: 'known' | 'unknown';
  readonly requirement: DiscordAccessRequirement | null;
}

export interface ToolAccessCoverageEntry extends ToolAccessRequirement {
  readonly source: 'colocated' | 'registry' | 'unknown';
}

const guild = (
  permissions: readonly DiscordPermissionName[],
  intents: readonly GatewayIntentName[] = [],
  hierarchy: DiscordAccessRequirement['hierarchy'] = 'not_applicable',
  auth: AuthKind = 'bot',
): DiscordAccessRequirement => ({
  auth,
  permissions,
  intents,
  scope: 'guild',
  hierarchy,
});

const channel = (
  permissions: readonly DiscordPermissionName[],
  auth: AuthKind = 'bot',
  intents: readonly GatewayIntentName[] = [],
  permissionTargetFields?: readonly string[],
  allowCrossGuild?: boolean,
): DiscordAccessRequirement => ({
  auth,
  permissions,
  intents,
  scope: 'channel',
  hierarchy: 'not_applicable',
  ...(permissionTargetFields === undefined ? {} : { permissionTargetFields }),
  ...(allowCrossGuild === undefined ? {} : { allowCrossGuild }),
});

const globalBotRead = (
  permissions: readonly DiscordPermissionName[] = [],
  intents: readonly GatewayIntentName[] = [],
): DiscordAccessRequirement => ({
  auth: 'bot',
  permissions,
  intents,
  scope: 'global',
  hierarchy: 'not_applicable',
});

const historyRead = channel(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY']);
const messageRead = channel(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'], 'bot', ['MESSAGE_CONTENT']);
const channelRead = channel(['VIEW_CHANNEL']);
const messageWrite = channel(['VIEW_CHANNEL', 'SEND_MESSAGES']);
const messageModerate = channel(['VIEW_CHANNEL', 'MANAGE_MESSAGES']);
const channelManage = channel(['VIEW_CHANNEL', 'MANAGE_CHANNELS']);
const guildManage = guild(['MANAGE_GUILD']);
const roleManage = guild(['MANAGE_ROLES'], [], 'required');
const expressionManage = guild(['MANAGE_GUILD_EXPRESSIONS']);
const webhookManage = channel(['VIEW_CHANNEL', 'MANAGE_WEBHOOKS']);
const expressionCreate = guild(['CREATE_GUILD_EXPRESSIONS']);
const soundboardSend = {
  auth: 'bot',
  permissions: ['VIEW_CHANNEL', 'SPEAK', 'USE_SOUNDBOARD'] as const,
  intents: [],
  scope: 'channel',
  hierarchy: 'not_applicable',
  conditions: [
    {
      fields: ['source_guild_id'],
      permissions: ['USE_EXTERNAL_SOUNDS'] as const,
    },
  ],
} as const satisfies DiscordAccessRequirement;

const memberModify = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'guild',
  hierarchy: 'not_applicable',
  permissionTargetFields: ['channel_id'],
  conditions: [
    { fields: ['nick'], permissions: ['MANAGE_NICKNAMES'], hierarchy: 'required' },
    { fields: ['roles'], permissions: ['MANAGE_ROLES'], hierarchy: 'required' },
    { fields: ['mute'], permissions: ['MUTE_MEMBERS'], hierarchy: 'required' },
    { fields: ['deaf'], permissions: ['DEAFEN_MEMBERS'], hierarchy: 'required' },
    {
      fields: ['channel_id'],
      permissions: ['MOVE_MEMBERS'],
      hierarchy: 'required',
      when: { channel_id: null },
    },
    {
      fields: ['channel_id'],
      permissions: ['MOVE_MEMBERS', 'CONNECT'],
      hierarchy: 'required',
      nonNullFields: ['channel_id'],
    },
    {
      fields: ['communication_disabled_until'],
      permissions: ['MODERATE_MEMBERS'],
      hierarchy: 'required',
    },
  ],
  requireConditionMatch: true,
} as const satisfies DiscordAccessRequirement;

const currentVoiceStateModify = {
  auth: 'bot',
  permissions: [],
  intents: [],
  scope: 'guild',
  hierarchy: 'not_applicable',
  conditions: [
    { fields: ['channel_id'], permissions: [] },
    { fields: ['suppress'], permissions: ['MUTE_MEMBERS'], when: { suppress: false } },
    {
      fields: ['request_to_speak_timestamp'],
      permissions: [],
      when: { request_to_speak_timestamp: null },
    },
    {
      fields: ['request_to_speak_timestamp'],
      permissions: ['REQUEST_TO_SPEAK'],
      nonNullFields: ['request_to_speak_timestamp'],
    },
  ],
  requireConditionMatch: true,
} as const satisfies DiscordAccessRequirement;

const TOOL_REQUIREMENTS: Readonly<Record<string, DiscordAccessRequirement>> = {
  audit_log_get: guild(['VIEW_AUDIT_LOG']),
  automod_create_rule: guild(['MANAGE_GUILD']),
  automod_delete_rule: guild(['MANAGE_GUILD']),
  automod_modify_rule: guild(['MANAGE_GUILD']),
  automod_get_rule: guildManage,
  automod_list_rules: guildManage,
  // These application-scoped operations are also declared colocated on the
  // tool definitions. Keeping the same contracts in this central catalogue
  // lets credential-free consumers such as `doctor --access` report them
  // without dynamically loading every tool module.
  app_emojis_list: BOT_APPLICATION_READ_ACCESS,
  app_emojis_get: BOT_APPLICATION_READ_ACCESS,
  app_emojis_create: BOT_APPLICATION_ACCESS,
  app_emojis_delete: BOT_APPLICATION_ACCESS,
  app_emojis_modify: BOT_APPLICATION_ACCESS,
  application_get_activity_instance: BOT_APPLICATION_READ_ACCESS,
  application_get_current: BOT_APPLICATION_READ_ACCESS,
  application_modify_current: BOT_APPLICATION_ACCESS,
  application_get_role_connection_metadata: BOT_APPLICATION_READ_ACCESS,
  application_modify_role_connection_metadata: BOT_APPLICATION_ACCESS,
  commands_bulk_overwrite_global: BOT_APPLICATION_ACCESS,
  commands_create_global: BOT_APPLICATION_ACCESS,
  commands_delete_global: BOT_APPLICATION_ACCESS,
  commands_modify_global: BOT_APPLICATION_ACCESS,
  commands_list_global: BOT_APPLICATION_READ_ACCESS,
  commands_get_global: BOT_APPLICATION_READ_ACCESS,
  commands_bulk_overwrite_guild: BOT_APPLICATION_ACCESS,
  commands_create_guild: BOT_APPLICATION_ACCESS,
  commands_delete_guild: BOT_APPLICATION_ACCESS,
  commands_modify_guild: BOT_APPLICATION_ACCESS,
  commands_list_guild: BOT_APPLICATION_READ_ACCESS,
  commands_get_guild: BOT_APPLICATION_READ_ACCESS,
  commands_get_command_permissions: guild([]),
  commands_get_guild_command_permissions: guild([]),
  skus_list: BOT_APPLICATION_READ_ACCESS,
  subscriptions_list: BOT_APPLICATION_READ_ACCESS,
  subscriptions_get: BOT_APPLICATION_READ_ACCESS,
  entitlements_list: BOT_APPLICATION_READ_ACCESS,
  entitlements_get: BOT_APPLICATION_READ_ACCESS,
  entitlements_consume: BOT_APPLICATION_ACCESS,
  entitlements_create_test: BOT_APPLICATION_ACCESS,
  entitlements_delete_test: BOT_APPLICATION_ACCESS,
  // SKU routes do not carry an application_id; the runtime resolver binds the
  // SKU back to `/skus/{id}` before admitting the call.
  components_v2_send: CHANNEL_WRITE_ACCESS,
  components_v2_edit: CHANNEL_WRITE_ACCESS,
  components_v2_send_from_template: CHANNEL_WRITE_ACCESS,
  guild_get: GUILD_READ_ACCESS,
  roles_list: GUILD_READ_ACCESS,
  channels_list: GUILD_READ_ACCESS,
  channels_list_active_threads_guild: GUILD_READ_ACCESS,
  events_get: GUILD_READ_ACCESS,
  events_list: GUILD_READ_ACCESS,
  events_list_users: guild([]),
  // Discord requires both permissions for prune preview and execution.
  guild_get_prune_count: guild(['MANAGE_GUILD', 'KICK_MEMBERS']),
  guild_get_vanity_url: guild(['MANAGE_GUILD']),
  guild_get_welcome_screen: GUILD_READ_ACCESS,
  guild_get_widget: PUBLIC_GUILD_ACCESS,
  guild_get_widget_image_url: PUBLIC_GUILD_ACCESS,
  guild_get_widget_settings: guild(['MANAGE_GUILD']),
  guild_list_integrations: guildManage,
  guild_list_voice_regions: GUILD_READ_ACCESS,
  onboarding_get: GUILD_READ_ACCESS,
  soundboard_list_guild_sounds: GUILD_READ_ACCESS,
  soundboard_get_guild_sound: GUILD_READ_ACCESS,
  stickers_list_guild: GUILD_READ_ACCESS,
  stickers_get_guild_sticker: GUILD_READ_ACCESS,
  templates_list: GUILD_READ_ACCESS,
  voice_get_current_user_state: GUILD_READ_ACCESS,
  voice_get_user_state: GUILD_READ_ACCESS,
  members_get: GUILD_READ_ACCESS,
  members_get_ban: guild(['BAN_MEMBERS']),
  members_list_bans: guild(['BAN_MEMBERS']),
  members_get_current_user: GUILD_READ_ACCESS,
  members_search: guild([]),
  members_list: guild([], ['GUILD_MEMBERS']),
  emojis_get: GUILD_READ_ACCESS,
  emojis_list_guild: GUILD_READ_ACCESS,
  channels_create_guild_channel: guild(['MANAGE_CHANNELS']),
  channels_get: CHANNEL_READ_ACCESS,
  channels_delete: channelManage,
  channels_modify: channelManage,
  channels_forum_create_thread: channel(['VIEW_CHANNEL', 'SEND_MESSAGES']),
  channels_list_joined_private_archived_threads: historyRead,
  channels_list_private_archived_threads: channel([
    'VIEW_CHANNEL',
    'READ_MESSAGE_HISTORY',
    'MANAGE_THREADS',
  ]),
  channels_list_public_archived_threads: historyRead,
  channels_trigger_typing: messageWrite,
  channels_delete_permissions: channel(['MANAGE_ROLES']),
  channels_modify_permissions: channel(['MANAGE_ROLES']),
  // Discord documents MANAGE_WEBHOOKS on the follower destination; the source
  // channel is still resolved first so a missing/hidden source fails closed.
  channels_follow_announcement: channel(
    ['VIEW_CHANNEL', 'MANAGE_WEBHOOKS'],
    'bot',
    [],
    ['webhook_channel_id'],
    true,
  ),
  events_create: {
    ...guild(['CREATE_EVENTS']),
    permissionTargetFields: ['channel_id'],
    conditions: [
      {
        fields: ['entity_type'],
        permissions: ['MANAGE_CHANNELS', 'MUTE_MEMBERS', 'MOVE_MEMBERS'],
        when: { entity_type: 1 },
      },
      {
        fields: ['entity_type'],
        permissions: ['VIEW_CHANNEL', 'CONNECT'],
        when: { entity_type: 2 },
      },
    ],
  },
  events_delete: guild(['MANAGE_EVENTS']),
  events_modify: guild(['MANAGE_EVENTS']),
  guild_modify: guildManage,
  guild_modify_welcome_screen: guildManage,
  guild_modify_widget: guildManage,
  guild_begin_prune: guild(['MANAGE_GUILD', 'KICK_MEMBERS']),
  guild_delete_integration: guildManage,
  guild_modify_current_voice_state: currentVoiceStateModify,
  // The voice-state endpoint requires MUTE_MEMBERS (not MOVE_MEMBERS), even
  // though it is commonly used to unsuppress a stage participant.
  guild_modify_user_voice_state: guild(['MUTE_MEMBERS'], [], 'required'),
  // Discord's onboarding update endpoint requires both permissions.
  onboarding_modify: guild(['MANAGE_GUILD', 'MANAGE_ROLES']),
  commands_edit_command_permissions: guild(['MANAGE_GUILD'], [], 'not_applicable', 'bearer'),
  members_add_role: roleManage,
  members_ban: guild(['BAN_MEMBERS'], [], 'required'),
  members_bulk_ban: guild(['BAN_MEMBERS', 'MANAGE_GUILD'], [], 'required'),
  members_kick: guild(['KICK_MEMBERS'], [], 'required'),
  members_remove_role: roleManage,
  members_modify: memberModify,
  members_modify_current: guild(['CHANGE_NICKNAME']),
  members_unban: guild(['BAN_MEMBERS']),
  messages_bulk_delete: channel(['MANAGE_MESSAGES']),
  messages_delete: channel(['MANAGE_MESSAGES']),
  messages_send: channel(['VIEW_CHANNEL', 'SEND_MESSAGES']),
  messages_pin: channel(['PIN_MESSAGES']),
  messages_unpin: channel(['PIN_MESSAGES']),
  messages_get: messageRead,
  messages_read: messageRead,
  messages_search_recent: messageRead,
  messages_list_pins: messageRead,
  messages_edit: messageModerate,
  messages_crosspost: messageModerate,
  messages_create_thread: channel(['VIEW_CHANNEL', 'CREATE_PUBLIC_THREADS']),
  reactions_create: channel(['VIEW_CHANNEL', 'ADD_REACTIONS']),
  reactions_list: historyRead,
  reactions_delete_own: channel(['VIEW_CHANNEL']),
  reactions_delete_all: messageModerate,
  reactions_delete_user: messageModerate,
  polls_get_voters: historyRead,
  polls_end: messageModerate,
  threads_join: channel(['VIEW_CHANNEL']),
  threads_leave: channel(['VIEW_CHANNEL']),
  threads_add_member: channel(['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS']),
  threads_remove_member: channel(['VIEW_CHANNEL', 'MANAGE_THREADS']),
  threads_get_member: channelRead,
  roles_create: roleManage,
  roles_delete: roleManage,
  roles_modify: roleManage,
  roles_modify_positions: roleManage,
  emojis_create: expressionCreate,
  emojis_delete: expressionManage,
  emojis_modify: expressionManage,
  stickers_create_guild_sticker: expressionCreate,
  stickers_delete_guild_sticker: expressionManage,
  stickers_modify_guild_sticker: expressionManage,
  soundboard_create_guild_sound: expressionCreate,
  soundboard_modify_guild_sound: guild(['MANAGE_GUILD_EXPRESSIONS']),
  soundboard_delete_guild_sound: guild(['MANAGE_GUILD_EXPRESSIONS']),
  soundboard_send_sound: soundboardSend,
  soundboard_list_default_sounds: globalBotRead(),
  stickers_list_packs: globalBotRead(),
  voice_list_regions: globalBotRead(),
  stage_instances_get: channelRead,
  stage_instances_create: channel([
    'VIEW_CHANNEL',
    'MANAGE_CHANNELS',
    'MUTE_MEMBERS',
    'MOVE_MEMBERS',
  ]),
  stage_instances_modify: channel([
    'VIEW_CHANNEL',
    'MANAGE_CHANNELS',
    'MUTE_MEMBERS',
    'MOVE_MEMBERS',
  ]),
  stage_instances_delete: channel([
    'VIEW_CHANNEL',
    'MANAGE_CHANNELS',
    'MUTE_MEMBERS',
    'MOVE_MEMBERS',
  ]),
  invites_create_channel: channel(['VIEW_CHANNEL', 'CREATE_INSTANT_INVITE']),
  invites_list_channel: channel(['VIEW_CHANNEL', 'MANAGE_CHANNELS']),
  invites_get: PUBLIC_GUILD_ACCESS,
  invites_delete: guild(['MANAGE_CHANNELS']),
  webhooks_list_channel: channel(['VIEW_CHANNEL', 'MANAGE_WEBHOOKS']),
  webhooks_list_guild: guild(['MANAGE_WEBHOOKS']),
  webhooks_get: webhookManage,
  webhooks_create: webhookManage,
  webhooks_modify: webhookManage,
  webhooks_delete: webhookManage,
  templates_create: guildManage,
  templates_delete: guildManage,
  templates_modify: guildManage,
  templates_sync: guildManage,
  templates_diff: GUILD_READ_ACCESS,
  templates_get: globalBotRead(),
  templates_inspect: globalBotRead(),
  templates_recommend: globalBotRead(),
  guild_blueprint_compile: globalBotRead(),
  guild_blueprint_plan: BLUEPRINT_GUILD_ACCESS,
  guild_blueprint_apply: BLUEPRINT_GUILD_ACCESS,
  guild_blueprint_evidence: BLUEPRINT_GUILD_ACCESS,
  users_get_current: BOT_APPLICATION_READ_ACCESS,
  users_modify_current: BOT_APPLICATION_ACCESS,
  users_list_current_user_guilds: globalBotRead(),
  components_v2_build_container: LOCAL_ACCESS,
  components_v2_build_media_gallery: LOCAL_ACCESS,
  components_v2_build_section: LOCAL_ACCESS,
  components_v2_preview: LOCAL_ACCESS,
  components_v2_validate: LOCAL_ACCESS,
  inspiration_emoji_gg_search: EXTERNAL_ACCESS,
  // These routes carry their own short-lived credential. Guild allowlist
  // policy still rejects interaction tokens whose guild cannot be proven.
  interactions_create_followup: OPAQUE_TOKEN_ACCESS,
  interactions_create_response: OPAQUE_TOKEN_ACCESS,
  interactions_delete_followup: OPAQUE_TOKEN_ACCESS,
  interactions_delete_original_response: OPAQUE_TOKEN_ACCESS,
  interactions_edit_followup: OPAQUE_TOKEN_ACCESS,
  interactions_edit_original_response: OPAQUE_TOKEN_ACCESS,
  interactions_get_followup: OPAQUE_TOKEN_ACCESS,
  interactions_get_original_response: OPAQUE_TOKEN_ACCESS,
  webhooks_delete_message: OPAQUE_TOKEN_ACCESS,
  webhooks_delete_with_token: OPAQUE_TOKEN_ACCESS,
  webhooks_edit_message: OPAQUE_TOKEN_ACCESS,
  webhooks_execute: OPAQUE_TOKEN_ACCESS,
  webhooks_get_message: OPAQUE_TOKEN_ACCESS,
  webhooks_get_with_token: OPAQUE_TOKEN_ACCESS,
  webhooks_modify_with_token: OPAQUE_TOKEN_ACCESS,
  stickers_get: globalBotRead(),
  users_get: globalBotRead(),
  users_leave_guild: GUILD_READ_ACCESS,
  users_create_dm: USER_SCOPED_ACCESS,
  permissions_audit_channel: channelRead,
  permissions_explain: GUILD_READ_ACCESS,
  intelligence_classify_messages: messageRead,
  intelligence_draft_response: messageRead,
  intelligence_extract_entities: messageRead,
  intelligence_summarize_channel: messageRead,
  intelligence_moderate_content: EXTERNAL_ACCESS,
  mcp_pipeline: LOCAL_ACCESS,
  threads_list_members: guild([], ['GUILD_MEMBERS']),
};

/**
 * Return the requirement for a tool without consulting runtime state.
 * Unknown tools remain explicit so callers can fail closed or show an
 * actionable "requirement not catalogued" result.
 */
export function getToolAccessRequirement(toolName: string): ToolAccessRequirement {
  const requirement = TOOL_REQUIREMENTS[toolName];
  return requirement === undefined
    ? { toolName, status: 'unknown', requirement: null }
    : { toolName, status: 'known', requirement: cloneRequirement(requirement) };
}

/**
 * Resolve field-dependent access for one validated payload. A conditional
 * contract never widens access when the action cannot be identified; callers
 * receive `null` and can fail closed.
 */
export function resolveToolAccessRequirement(
  toolName: string,
  args: unknown,
  colocated?: DiscordAccessRequirement,
): DiscordAccessRequirement | null {
  const requirement = colocated ?? getToolAccessRequirement(toolName).requirement;
  if (requirement === null) return null;
  if (requirement.conditions === undefined) return cloneRequirement(requirement);

  const record = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const matched = requirement.conditions.filter((condition) =>
    condition.fields.some((field) => {
      const value = (record as Record<string, unknown>)[field];
      if (value === undefined) return false;
      if (
        condition.nonNullFields?.some((requiredField) => {
          const requiredValue = (record as Record<string, unknown>)[requiredField];
          return requiredValue === undefined || requiredValue === null;
        })
      ) {
        return false;
      }
      if (condition.when === undefined) return true;
      return Object.entries(condition.when).every(([key, expected]) => {
        return (record as Record<string, unknown>)[key] === expected;
      });
    }),
  );
  if (matched.length === 0 && requirement.requireConditionMatch === true) return null;

  const permissions: DiscordPermissionName[] = [...requirement.permissions];
  for (const condition of matched) {
    for (const permission of condition.permissions) {
      if (!permissions.includes(permission)) permissions.push(permission);
    }
  }
  const hierarchy =
    requirement.hierarchy === 'required' ||
    matched.some((condition) => condition.hierarchy === 'required')
      ? ('required' as const)
      : ('not_applicable' as const);
  const {
    conditions: _conditions,
    requireConditionMatch: _requireConditionMatch,
    ...base
  } = requirement;
  return {
    ...base,
    permissions,
    hierarchy,
  };
}

export function listKnownToolAccessRequirements(): readonly ToolAccessRequirement[] {
  return Object.entries(TOOL_REQUIREMENTS).map(([toolName, requirement]) => ({
    toolName,
    status: 'known' as const,
    requirement: cloneRequirement(requirement),
  }));
}

function cloneRequirement(requirement: DiscordAccessRequirement): DiscordAccessRequirement {
  return {
    ...requirement,
    permissions: [...requirement.permissions],
    intents: [...requirement.intents],
    ...(requirement.permissionTargetFields === undefined
      ? {}
      : { permissionTargetFields: [...requirement.permissionTargetFields] }),
    ...(requirement.conditions === undefined
      ? {}
      : {
          conditions: requirement.conditions.map((condition) => ({
            ...condition,
            fields: [...condition.fields],
            permissions: [...condition.permissions],
            ...(condition.when === undefined ? {} : { when: { ...condition.when } }),
            ...(condition.nonNullFields === undefined
              ? {}
              : { nonNullFields: [...condition.nonNullFields] }),
          })),
        }),
  };
}

/**
 * Audit tool metadata without contacting Discord. Colocated metadata wins;
 * the conservative central registry is a migration fallback. Unknown tools
 * remain visible so a caller cannot mistake partial coverage for full safety.
 */
export function auditToolAccessCoverage(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly access?: DiscordAccessRequirement;
  }>,
): {
  readonly total: number;
  readonly known: number;
  readonly registryFallback: number;
  readonly colocated: number;
  readonly unknown: number;
  readonly entries: readonly ToolAccessCoverageEntry[];
} {
  const entries = tools.map((tool) => {
    if (tool.access !== undefined) {
      return {
        toolName: tool.name,
        status: 'known' as const,
        source: 'colocated' as const,
        requirement: cloneRequirement(tool.access),
      };
    }
    const fallback = getToolAccessRequirement(tool.name);
    return {
      ...fallback,
      source: fallback.status === 'known' ? ('registry' as const) : ('unknown' as const),
    };
  });
  return {
    total: entries.length,
    known: entries.filter((entry) => entry.status === 'known').length,
    registryFallback: entries.filter((entry) => entry.source === 'registry').length,
    colocated: entries.filter((entry) => entry.source === 'colocated').length,
    unknown: entries.filter((entry) => entry.status === 'unknown').length,
    entries,
  };
}
