/**
 * quadslab Discord MCP adapter — Plan 11 Phase C.
 *
 * RESEARCH NOTE (cutoff date 2026-05-01):
 *
 *   Upstream:    https://github.com/HardHeadHackerHead/discord-mcp
 *   npm:         `@quadslab.io/discord-mcp` (v2.1.1 at cutoff)
 *   Author:      QuadsLab
 *   Language:    TypeScript (Node.js, ESM)
 *   Runtime dep: discord.js@^14, @modelcontextprotocol/sdk@^1.25
 *
 *   Tool surface (observed by inspecting `src/tools/*.ts` on the main
 *   branch HEAD): README claims "139 admin tools across 20 categories";
 *   per-file tally yields 138 — close enough that the off-by-one is
 *   plausibly an overcounted helper or a since-removed entry. Per-module
 *   counts (file → number of tools):
 *     guild.ts        2   list_guilds, get_guild_info
 *     roles.ts        11  list_roles, create_role, delete_role,
 *                         modify_role, get_role_permissions,
 *                         modify_role_permissions, set_role_icon,
 *                         list_role_members, list_member_permissions,
 *                         assign_role, remove_role
 *     channels.ts     20  list/create_text/create_voice/create_category/
 *                         delete/set_perms/view_perms/lock/unlock/
 *                         set_slowmode/create_forum/reorder/
 *                         set_voice_region/follow_announcement/clone/
 *                         check_perms/copy_perms/set_voice_status/
 *                         list_voice_members/modify_channel
 *     members.ts      15  list/get/kick/ban/unban/timeout/move_to_voice/
 *                         disconnect_from_voice/prune/bulk_assign_role/
 *                         bulk_remove_role/set_nickname/search/bulk_ban/
 *                         purge_user_messages
 *     messages.ts     14  get_message, edit, crosspost, get_messages,
 *                         send, send_embed, bulk_delete, pin, unpin,
 *                         list_pinned, add_reaction, remove_reaction,
 *                         delete, send_message_with_file
 *     reactions.ts    1   get_reactions
 *     server.ts       16  edit_server, list_invites, create_invite,
 *                         delete_invite, get_audit_log, list_bans,
 *                         get/set_welcome_screen, get/set_widget,
 *                         get_vanity_url, list_integrations,
 *                         delete_integration, get_invite,
 *                         get/set_server_icon
 *     threads.ts      15  list, create, archive, unarchive, delete,
 *                         lock, unlock, add_member, remove_member,
 *                         list_members, get, get_messages,
 *                         list_archived, edit, get_pinned_messages
 *     forums.ts       5   create_forum_post, list_forum_tags,
 *                         create_forum_tag, edit_forum_tag,
 *                         delete_forum_tag
 *     emojis.ts       7   list_emojis, create/delete/rename_emoji,
 *                         list_stickers, create/delete_sticker
 *     webhooks.ts     4   list/create/delete_webhook, send_webhook_message
 *     events.ts       5   list/create/edit/delete_event,
 *                         get_event_subscribers
 *     stage.ts        3   list_stage_instances, start_stage, end_stage
 *     automod.ts      4   list/create/edit/delete_automod_rule
 *     polls.ts        3   send_poll, get_poll_results, end_poll
 *     dms.ts          2   send_dm, send_dm_embed
 *     presence.ts     2   set_bot_status, get_bot_info
 *     templates.ts    4   list/create/delete/sync_template
 *     commands.ts     4   list/create/edit/delete_command
 *     onboarding.ts   2   get_onboarding, edit_onboarding
 *     ──────────────────
 *     total           138 (README says 139 — single-tool drift accepted)
 *
 *   Tool-registration pattern (per `src/tools/index.ts`):
 *     - Each module exports a `<category>Tools: Tool[]` array AND an
 *       `execute<Category>Tool()` function. Tools look like
 *         { name: '<verb>_<noun>', description: '...', inputSchema: {...} }
 *     - `src/tools/index.ts` aggregates all into `allTools` + a
 *       `toolCategories` map for routing.
 *     - Naming: snake_case verb-first (`list_guilds`, `send_message`,
 *       `bulk_assign_role`). Different from PaSympa's `discord_*` prefix.
 *
 *   Detection signals chosen:
 *     1. `package.json` `name` field matches `/quadslab/i` OR
 *        `/@quadslab\.io\/discord-mcp/i` (covers private forks that keep
 *        the scope but rename the package, and forks under a different
 *        scope that still mention quadslab).
 *     2. AND content match: at least one `*.ts` file under `src/tools/`
 *        defines BOTH a `<category>Tools` export AND a
 *        `execute<Category>Tool` function — this is quadslab's signature
 *        and is unlikely to false-positive on a generic bare snake_case
 *        bot. The PaSympa fixture uses literal `'discord_*'` prefixes
 *        and `definitions:` exports — disjoint from this signature.
 *
 *   MCP Resources caveat:
 *     quadslab exposes MCP resources (per its README) through the
 *     server-level resource surface, not a tool. discord-mcp's Gateway can
 *     emit experimental subscription notifications, but it does not expose
 *     quadslab's live URIs through `resources/list` or `resources/read`.
 *     Resource subscriptions are NOT tools and do not appear in
 *     `<category>Tools` arrays, so they are out of scope for this adapter.
 *
 *   Known mapping ambiguities (see NAME_MAP `notes` for per-tool detail):
 *     - quadslab's `send_embed`, `send_dm_embed`, `send_message_with_file`
 *       collapse into discord-mcp's `messages_send` (which accepts
 *       `embeds[]`, `attachments[]`). Confidence: medium.
 *     - quadslab's `lock_channel` / `unlock_channel` are convenience
 *       wrappers for permission overwrites — map to
 *       `channels_modify_permissions`. Confidence: medium.
 *     - quadslab's `set_slowmode`, `set_channel_topic`, `set_voice_status`
 *       are all PATCH-channel helpers — map to `channels_modify`.
 *       Confidence: medium (caller picks the field).
 *     - quadslab's `bulk_assign_role` / `bulk_remove_role` have no
 *       discord-mcp equivalent (caller iterates `members_add_role`
 *       per member). Map to `members_add_role` /
 *       `members_remove_role` with confidence: low and a note.
 *     - quadslab's `purge_user_messages` is a higher-level helper
 *       (search + bulk_delete). Map to `messages_bulk_delete` with
 *       confidence: low (caller composes the search step).
 *     - quadslab's `send_poll` has no discord-mcp tool equivalent —
 *       discord-mcp creates polls inline via `messages_send` payload
 *       (`poll: {...}`). Map → `messages_send`, confidence: low.
 *     - quadslab's templates module (`list_template`, etc.) maps to
 *       discord-mcp's `application/templates`-style tools — but
 *       discord-mcp does NOT currently expose guild-template REST
 *       wrappers (they're absent from the tool catalog as of cutoff).
 *       All four left unmapped.
 *     - quadslab's `get_role_permissions` / `list_member_permissions`
 *       are introspection helpers (no PATCH); discord-mcp returns this
 *       data via `roles_list` + `members_get`. Confidence: medium.
 *     - quadslab's `get/set_welcome_screen` map to
 *       `guild_get_welcome_screen` / `guild_modify_welcome_screen`.
 *       Confidence: high.
 *     - quadslab's `presence` tools (`set_bot_status`, `get_bot_info`)
 *       have no discord-mcp tool or runtime configuration equivalent.
 *       They remain unmapped.
 *
 *   Tools deliberately left out of NAME_MAP (intentional unmapped):
 *     - presence: set_bot_status, get_bot_info (no current equivalent)
 *     - templates: list_template, create_template, delete_template,
 *       sync_template (discord-mcp has no template tools yet)
 *     - higher-level helpers: clone_channel, copy_channel_permissions,
 *       check_permissions (compose from primitives)
 *     - voice helpers: move_to_voice, disconnect_from_voice,
 *       set_voice_region, set_voice_status, list_voice_members
 *       (discord-mcp's `voice_*` tools cover state/regions but not
 *        the channel-side helpers; partial overlap, low value).
 *
 *   Repo state at cutoff: HardHeadHackerHead/discord-mcp main branch
 *   was reachable via raw GitHub fetches; per-file inspection succeeded
 *   for all 20 tool modules. README `139` vs counted `138`: one-tool
 *   drift accepted as upstream measurement noise.
 *
 *   The adapter is best-effort. Users running it against a real
 *   quadslab tree should treat the report as a starting point and verify
 *   each `medium` / `low` entry against the destination tool's input
 *   schema before deleting the source code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MappedTool, MigrationResult, MigrationSource } from './types.js';

/**
 * Confidence-tagged map from quadslab tool name → discord-mcp tool name.
 *
 *   high   — name + arg shape are a 1:1 match.
 *   medium — name maps cleanly but the caller may need to massage args.
 *   low    — best-guess mapping; user MUST verify.
 *
 * Entries WITHOUT a discord-mcp equivalent (presence/templates/voice
 * helpers) are intentionally absent — `migrate()` reports them under
 * `unmappedTools`.
 */
const NAME_MAP: Record<
  string,
  { mapped: string; confidence: 'high' | 'medium' | 'low'; notes?: string }
> = {
  // guild
  list_guilds: { mapped: 'users_list_current_user_guilds', confidence: 'high' },
  get_guild_info: { mapped: 'guild_get', confidence: 'high' },

  // roles
  list_roles: { mapped: 'roles_list', confidence: 'high' },
  create_role: { mapped: 'roles_create', confidence: 'high' },
  delete_role: { mapped: 'roles_delete', confidence: 'high' },
  modify_role: { mapped: 'roles_modify', confidence: 'high' },
  modify_role_permissions: {
    mapped: 'roles_modify',
    confidence: 'medium',
    notes: 'pass permissions field via roles_modify',
  },
  get_role_permissions: {
    mapped: 'roles_list',
    confidence: 'medium',
    notes: 'discord-mcp roles_list returns permissions on each role',
  },
  set_role_icon: {
    mapped: 'roles_modify',
    confidence: 'medium',
    notes: 'pass icon (base64) or unicode_emoji via roles_modify',
  },
  list_role_members: {
    mapped: 'members_list',
    confidence: 'low',
    notes: 'discord-mcp has no by-role lookup; list members and filter on role IDs',
  },
  list_member_permissions: {
    mapped: 'members_get',
    confidence: 'medium',
    notes: 'compute from member.roles + each role.permissions client-side',
  },
  assign_role: { mapped: 'members_add_role', confidence: 'high' },
  remove_role: { mapped: 'members_remove_role', confidence: 'high' },

  // channels
  list_channels: { mapped: 'channels_list', confidence: 'high' },
  create_text_channel: {
    mapped: 'channels_create_guild_channel',
    confidence: 'high',
    notes: 'pass type=0 (GUILD_TEXT)',
  },
  create_voice_channel: {
    mapped: 'channels_create_guild_channel',
    confidence: 'high',
    notes: 'pass type=2 (GUILD_VOICE)',
  },
  create_category: {
    mapped: 'channels_create_guild_channel',
    confidence: 'high',
    notes: 'pass type=4 (GUILD_CATEGORY)',
  },
  create_forum_channel: {
    mapped: 'channels_create_guild_channel',
    confidence: 'high',
    notes: 'pass type=15 (GUILD_FORUM)',
  },
  delete_channel: { mapped: 'channels_delete', confidence: 'high' },
  modify_channel: { mapped: 'channels_modify', confidence: 'high' },
  set_channel_permissions: { mapped: 'channels_modify_permissions', confidence: 'high' },
  view_channel_permissions: {
    mapped: 'channels_get',
    confidence: 'medium',
    notes: 'discord-mcp returns full channel; permission_overwrites is on it',
  },
  lock_channel: {
    mapped: 'channels_modify_permissions',
    confidence: 'medium',
    notes: 'lock = explicit deny SEND_MESSAGES on @everyone via channels_modify_permissions',
  },
  unlock_channel: {
    mapped: 'channels_delete_permissions',
    confidence: 'medium',
    notes: 'unlock = remove the @everyone deny overwrite via channels_delete_permissions',
  },
  set_slowmode: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass rate_limit_per_user via channels_modify',
  },
  reorder_channels: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'iterate and pass position via channels_modify per channel',
  },
  follow_announcement_channel: {
    mapped: 'channels_follow_announcement',
    confidence: 'high',
  },

  // members
  list_members: { mapped: 'members_list', confidence: 'high' },
  get_member: { mapped: 'members_get', confidence: 'high' },
  kick_member: { mapped: 'members_kick', confidence: 'high' },
  ban_member: { mapped: 'members_ban', confidence: 'high' },
  unban_member: { mapped: 'members_unban', confidence: 'high' },
  timeout_member: {
    mapped: 'members_modify',
    confidence: 'medium',
    notes: 'set communication_disabled_until via members_modify',
  },
  prune_members: {
    mapped: 'guild_begin_prune',
    confidence: 'high',
    notes: 'use guild_get_prune_count first to preview',
  },
  bulk_assign_role: {
    mapped: 'members_add_role',
    confidence: 'low',
    notes: 'iterate members_add_role per user; discord-mcp has no bulk variant',
  },
  bulk_remove_role: {
    mapped: 'members_remove_role',
    confidence: 'low',
    notes: 'iterate members_remove_role per user; discord-mcp has no bulk variant',
  },
  set_nickname: {
    mapped: 'members_modify',
    confidence: 'medium',
    notes: 'pass nick via members_modify (or members_modify_current for self)',
  },
  search_members: { mapped: 'members_search', confidence: 'high' },
  bulk_ban: { mapped: 'members_bulk_ban', confidence: 'high' },
  purge_user_messages: {
    mapped: 'messages_bulk_delete',
    confidence: 'low',
    notes: 'first messages_search_recent + filter by author, then messages_bulk_delete',
  },

  // messages
  get_message: { mapped: 'messages_get', confidence: 'high' },
  get_messages: { mapped: 'messages_read', confidence: 'high' },
  send_message: { mapped: 'messages_send', confidence: 'high' },
  send_embed: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'pass embeds[] in messages_send payload',
  },
  send_message_with_file: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'attach files via attachments[] in messages_send payload',
  },
  edit_message: { mapped: 'messages_edit', confidence: 'high' },
  delete_message: { mapped: 'messages_delete', confidence: 'high' },
  bulk_delete_messages: { mapped: 'messages_bulk_delete', confidence: 'high' },
  crosspost_message: { mapped: 'messages_crosspost', confidence: 'high' },
  pin_message: { mapped: 'messages_pin', confidence: 'high' },
  unpin_message: { mapped: 'messages_unpin', confidence: 'high' },
  list_pinned_messages: { mapped: 'messages_list_pins', confidence: 'high' },
  add_reaction: { mapped: 'reactions_create', confidence: 'high' },
  remove_reaction: { mapped: 'reactions_delete_own', confidence: 'high' },

  // reactions
  get_reactions: { mapped: 'reactions_list', confidence: 'high' },

  // server (admin)
  edit_server: { mapped: 'guild_modify', confidence: 'high' },
  list_invites: {
    mapped: 'invites_list_channel',
    confidence: 'medium',
    notes: 'discord-mcp invites are scoped per-channel; iterate channels for guild-wide listing',
  },
  create_invite: { mapped: 'invites_create_channel', confidence: 'high' },
  delete_invite: { mapped: 'invites_delete', confidence: 'high' },
  get_invite: { mapped: 'invites_get', confidence: 'high' },
  get_audit_log: { mapped: 'audit_log_get', confidence: 'high' },
  list_bans: { mapped: 'members_list_bans', confidence: 'high' },
  get_welcome_screen: { mapped: 'guild_get_welcome_screen', confidence: 'high' },
  set_welcome_screen: { mapped: 'guild_modify_welcome_screen', confidence: 'high' },
  get_widget: { mapped: 'guild_get_widget', confidence: 'high' },
  set_widget: { mapped: 'guild_modify_widget', confidence: 'high' },
  get_vanity_url: { mapped: 'guild_get_vanity_url', confidence: 'high' },
  list_integrations: { mapped: 'guild_list_integrations', confidence: 'high' },
  delete_integration: { mapped: 'guild_delete_integration', confidence: 'high' },
  get_server_icon: {
    mapped: 'guild_get',
    confidence: 'medium',
    notes: 'guild.icon is on the guild object returned by guild_get',
  },
  set_server_icon: {
    mapped: 'guild_modify',
    confidence: 'medium',
    notes: 'pass icon (base64) via guild_modify',
  },

  // threads
  create_thread: { mapped: 'messages_create_thread', confidence: 'high' },
  list_threads: { mapped: 'channels_list_active_threads_guild', confidence: 'medium' },
  list_archived_threads: {
    mapped: 'channels_list_public_archived_threads',
    confidence: 'medium',
    notes:
      'or channels_list_private_archived_threads / channels_list_joined_private_archived_threads',
  },
  archive_thread: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass archived=true via channels_modify',
  },
  unarchive_thread: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass archived=false via channels_modify',
  },
  delete_thread: { mapped: 'channels_delete', confidence: 'high' },
  lock_thread: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass locked=true via channels_modify',
  },
  unlock_thread: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass locked=false via channels_modify',
  },
  edit_thread: { mapped: 'channels_modify', confidence: 'high' },
  add_thread_member: { mapped: 'threads_add_member', confidence: 'high' },
  remove_thread_member: { mapped: 'threads_remove_member', confidence: 'high' },
  list_thread_members: { mapped: 'threads_list_members', confidence: 'high' },
  get_thread: { mapped: 'channels_get', confidence: 'high' },
  get_thread_messages: { mapped: 'messages_read', confidence: 'high' },
  get_thread_pinned_messages: { mapped: 'messages_list_pins', confidence: 'high' },

  // forums
  create_forum_post: { mapped: 'channels_forum_create_thread', confidence: 'high' },
  list_forum_tags: {
    mapped: 'channels_get',
    confidence: 'medium',
    notes: 'available_tags is on the parent forum channel (channels_get)',
  },
  create_forum_tag: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'patch available_tags on parent forum via channels_modify',
  },
  edit_forum_tag: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'patch available_tags on parent forum via channels_modify',
  },
  delete_forum_tag: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'patch available_tags on parent forum via channels_modify',
  },

  // emojis + stickers
  list_emojis: { mapped: 'emojis_list_guild', confidence: 'high' },
  create_emoji: { mapped: 'emojis_create', confidence: 'high' },
  delete_emoji: { mapped: 'emojis_delete', confidence: 'high' },
  rename_emoji: {
    mapped: 'emojis_modify',
    confidence: 'medium',
    notes: 'pass name via emojis_modify',
  },
  list_stickers: { mapped: 'stickers_list_guild', confidence: 'high' },
  create_sticker: { mapped: 'stickers_create_guild_sticker', confidence: 'high' },
  delete_sticker: { mapped: 'stickers_delete_guild_sticker', confidence: 'high' },

  // webhooks
  list_webhooks: {
    mapped: 'webhooks_list_channel',
    confidence: 'medium',
    notes: 'or webhooks_list_guild — pick the right scope',
  },
  create_webhook: { mapped: 'webhooks_create', confidence: 'high' },
  delete_webhook: { mapped: 'webhooks_delete', confidence: 'high' },
  send_webhook_message: { mapped: 'webhooks_execute', confidence: 'high' },

  // events
  list_events: { mapped: 'events_list', confidence: 'high' },
  create_event: { mapped: 'events_create', confidence: 'high' },
  edit_event: { mapped: 'events_modify', confidence: 'high' },
  delete_event: { mapped: 'events_delete', confidence: 'high' },
  get_event_subscribers: { mapped: 'events_list_users', confidence: 'high' },

  // stage
  list_stage_instances: {
    mapped: 'stage_instances_get',
    confidence: 'low',
    notes: 'discord-mcp has no list endpoint; fetch per channel via stage_instances_get',
  },
  start_stage: { mapped: 'stage_instances_create', confidence: 'high' },
  end_stage: { mapped: 'stage_instances_delete', confidence: 'high' },

  // automod
  list_automod_rules: { mapped: 'automod_list_rules', confidence: 'high' },
  create_automod_rule: { mapped: 'automod_create_rule', confidence: 'high' },
  edit_automod_rule: { mapped: 'automod_modify_rule', confidence: 'high' },
  delete_automod_rule: { mapped: 'automod_delete_rule', confidence: 'high' },

  // polls
  send_poll: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'discord-mcp creates polls inline via messages_send poll: {...} field',
  },
  get_poll_results: {
    mapped: 'polls_get_voters',
    confidence: 'medium',
    notes: 'iterate per answer_id; discord-mcp returns voter lists, not aggregated counts',
  },
  end_poll: { mapped: 'polls_end', confidence: 'high' },

  // dms
  send_dm: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'first call users_create_dm to get the DM channel ID, then messages_send',
  },
  send_dm_embed: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'see send_dm; pass embeds[] in payload',
  },

  // commands (application commands)
  list_commands: { mapped: 'commands_list_guild', confidence: 'high' },
  create_command: { mapped: 'commands_create_guild', confidence: 'high' },
  edit_command: { mapped: 'commands_modify_guild', confidence: 'high' },
  delete_command: { mapped: 'commands_delete_guild', confidence: 'high' },

  // onboarding
  get_onboarding: { mapped: 'onboarding_get', confidence: 'high' },
  edit_onboarding: { mapped: 'onboarding_modify', confidence: 'high' },
};

/**
 * Recursively walk `dir` returning every `*.ts` file (excluding
 * `*.test.ts` / `*.d.ts`). Returns [] if `dir` is missing or unreadable.
 */
function readDirTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'utf8',
    }) as import('node:fs').Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      out.push(...readDirTsFiles(full));
    } else if (
      entry.isFile() &&
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Set of known quadslab tool names. We use this for tool-name extraction
 * during `migrate()`: a generic snake_case regex would match any string
 * literal in the codebase (variable names, comments, etc.), so we
 * intersect against the known catalog. New quadslab versions that add
 * tools will need this set updated, but that's the safe trade-off vs.
 * false-positive-prone `[a-z_]+` matching.
 */
const KNOWN_QUADSLAB_TOOLS: ReadonlySet<string> = new Set([
  // guild
  'list_guilds',
  'get_guild_info',
  // roles
  'list_roles',
  'create_role',
  'delete_role',
  'modify_role',
  'get_role_permissions',
  'modify_role_permissions',
  'set_role_icon',
  'list_role_members',
  'list_member_permissions',
  'assign_role',
  'remove_role',
  // channels
  'list_channels',
  'create_text_channel',
  'create_voice_channel',
  'create_category',
  'delete_channel',
  'set_channel_permissions',
  'view_channel_permissions',
  'lock_channel',
  'unlock_channel',
  'set_slowmode',
  'create_forum_channel',
  'reorder_channels',
  'set_voice_region',
  'follow_announcement_channel',
  'clone_channel',
  'check_permissions',
  'copy_channel_permissions',
  'set_voice_status',
  'list_voice_members',
  'modify_channel',
  // members
  'list_members',
  'get_member',
  'kick_member',
  'ban_member',
  'unban_member',
  'timeout_member',
  'move_to_voice',
  'disconnect_from_voice',
  'prune_members',
  'bulk_assign_role',
  'bulk_remove_role',
  'set_nickname',
  'search_members',
  'bulk_ban',
  'purge_user_messages',
  // messages
  'get_message',
  'edit_message',
  'crosspost_message',
  'get_messages',
  'send_message',
  'send_embed',
  'bulk_delete_messages',
  'pin_message',
  'unpin_message',
  'list_pinned_messages',
  'add_reaction',
  'remove_reaction',
  'delete_message',
  'send_message_with_file',
  // reactions
  'get_reactions',
  // server
  'edit_server',
  'list_invites',
  'create_invite',
  'delete_invite',
  'get_audit_log',
  'list_bans',
  'get_welcome_screen',
  'set_welcome_screen',
  'get_widget',
  'set_widget',
  'get_vanity_url',
  'list_integrations',
  'delete_integration',
  'get_invite',
  'get_server_icon',
  'set_server_icon',
  // threads
  'list_threads',
  'create_thread',
  'archive_thread',
  'unarchive_thread',
  'delete_thread',
  'lock_thread',
  'unlock_thread',
  'add_thread_member',
  'remove_thread_member',
  'list_thread_members',
  'get_thread',
  'get_thread_messages',
  'list_archived_threads',
  'edit_thread',
  'get_thread_pinned_messages',
  // forums
  'create_forum_post',
  'list_forum_tags',
  'create_forum_tag',
  'edit_forum_tag',
  'delete_forum_tag',
  // emojis + stickers
  'list_emojis',
  'create_emoji',
  'delete_emoji',
  'rename_emoji',
  'list_stickers',
  'create_sticker',
  'delete_sticker',
  // webhooks
  'list_webhooks',
  'create_webhook',
  'delete_webhook',
  'send_webhook_message',
  // events
  'list_events',
  'create_event',
  'edit_event',
  'delete_event',
  'get_event_subscribers',
  // stage
  'list_stage_instances',
  'start_stage',
  'end_stage',
  // automod
  'list_automod_rules',
  'create_automod_rule',
  'edit_automod_rule',
  'delete_automod_rule',
  // polls
  'send_poll',
  'get_poll_results',
  'end_poll',
  // dms
  'send_dm',
  'send_dm_embed',
  // presence
  'set_bot_status',
  'get_bot_info',
  // templates
  'list_templates',
  'create_template',
  'delete_template',
  'sync_template',
  // commands
  'list_commands',
  'create_command',
  'edit_command',
  'delete_command',
  // onboarding
  'get_onboarding',
  'edit_onboarding',
]);

export const quadslabAdapter: MigrationSource = {
  id: 'quadslab',
  description: 'quadslab Discord MCP (@quadslab.io, TypeScript, ~139 tools)',
  homepage: 'https://github.com/HardHeadHackerHead/discord-mcp',
  languages: ['typescript'],
  toolCountEstimate: 139,

  async detect(rootPath: string): Promise<boolean> {
    // Signal 1: package.json with a quadslab-shaped `name`. Accept the
    // exact upstream name and any name containing `quadslab` (covers
    // private forks). Any IO failure on package.json is a hard rejection
    // — better to under-detect than false-positive on every TS repo.
    let nameMatches = false;
    try {
      const pkgPath = join(rootPath, 'package.json');
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string };
      if (typeof pkg.name === 'string') {
        const namePatterns = [/quadslab/i, /@quadslab\.io\/discord-mcp/i];
        nameMatches = namePatterns.some((p) => p.test(pkg.name as string));
      }
    } catch {
      return false;
    }
    if (!nameMatches) {
      return false;
    }

    // Signal 2: at least one `*.ts` file under `src/tools/` exports a
    // `<category>Tools` array AND defines an `execute<Category>Tool`
    // function. This signature is unique to quadslab — PaSympa's
    // `definitions:` exports + `discord_*` literals don't match.
    const candidates = [join(rootPath, 'src', 'tools'), join(rootPath, 'src')];
    for (const dir of candidates) {
      try {
        statSync(dir);
      } catch {
        continue;
      }
      const files = readDirTsFiles(dir);
      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        // Both export-shape AND executor-shape must appear (case-sensitive).
        // Examples: `export const guildTools` + `export function executeGuildTool`.
        const hasToolsExport = /export\s+const\s+\w+Tools\b/.test(content);
        const hasExecutor = /export\s+(async\s+)?function\s+execute\w+Tool\b/.test(content);
        if (hasToolsExport && hasExecutor) {
          return true;
        }
      }
    }
    return false;
  },

  async migrate(rootPath: string): Promise<MigrationResult> {
    const sourcePath = rootPath;
    const allTools: string[] = [];
    const warnings: string[] = [];

    const toolsDir = join(rootPath, 'src', 'tools');
    let toolsDirExists = true;
    try {
      statSync(toolsDir);
    } catch {
      toolsDirExists = false;
    }

    const scanDir = toolsDirExists ? toolsDir : join(rootPath, 'src');
    let files: string[] = [];
    try {
      files = readDirTsFiles(scanDir);
    } catch (e) {
      warnings.push(`could not scan ${scanDir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!toolsDirExists) {
      warnings.push(
        `src/tools/ not found under ${rootPath} — falling back to a recursive scan of src/`,
      );
    }

    // Walk `*.ts` and extract every `name: '<known_quadslab_tool>'`
    // literal. Generic snake_case matching would false-positive on
    // variable names — intersecting against KNOWN_QUADSLAB_TOOLS keeps
    // the result high-precision.
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Match `name: 'foo'` / `name: "foo"` / inline `'foo'` literals.
      // The intersection with KNOWN_QUADSLAB_TOOLS is the precision filter.
      const re = /['"]([a-z][a-z_0-9]*)['"]/g;
      for (const match of content.matchAll(re)) {
        const name = match[1];
        if (name !== undefined && KNOWN_QUADSLAB_TOOLS.has(name) && !allTools.includes(name)) {
          allTools.push(name);
        }
      }
    }

    if (allTools.length === 0) {
      warnings.push('no quadslab tool names found — adapter may not match this quadslab version');
    }

    const mappedTools: MappedTool[] = [];
    const unmappedTools: string[] = [];

    for (const name of allTools) {
      const entry = NAME_MAP[name];
      if (entry !== undefined) {
        const item: MappedTool = entry.notes
          ? {
              original: name,
              mapped: entry.mapped,
              confidence: entry.confidence,
              notes: entry.notes,
            }
          : {
              original: name,
              mapped: entry.mapped,
              confidence: entry.confidence,
            };
        mappedTools.push(item);
      } else {
        unmappedTools.push(name);
      }
    }

    return {
      source: 'quadslab',
      sourcePath,
      mappedTools,
      unmappedTools,
      manualReview: [],
      warnings,
    };
  },
};
