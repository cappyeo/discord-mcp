/**
 * PaSympa Discord MCP adapter - Plan 11 Phase B.
 *
 * RESEARCH NOTE (cutoff date 2026-05-01):
 *
 *   Upstream:    https://github.com/PaSympa/discord-mcp
 *   Pinned at:   commit 9c76621 (main), release v1.4.1 (2026-03-25)
 *   Language:    TypeScript (Node.js, ESM with `.js` import suffixes)
 *   Package:     `@pasympa/discord-mcp` (per package.json `name` field)
 *
 *   Tool surface (observed by inspecting `src/tools/*.ts` on the pinned
 *   commit): roughly 91 tools per the README header. Per-module count:
 *     discovery       4   list_guilds, get_guild_info, list_channels,
 *                         find_channel_by_name
 *     messages        18  send/read/reply/edit/add_reaction/create_thread/
 *                         bulk_delete/embeds/delete/pin/search/crosspost/
 *                         remove_reactions/get_reactions/fetch_pinned/forward
 *     channels        8   create/delete/edit/move/clone/set_position/
 *                         follow_announcement/lock_permissions
 *     permissions     6   get_channel_permissions/set_role_permission/
 *                         set_member_permission/reset_channel_permissions/
 *                         copy_permissions/audit_permissions
 *     members         11  list/get_info/kick/ban/unban/timeout/search/
 *                         set_nickname/list_bans/bulk_ban/prune
 *     roles           9   list/create/edit/delete/add/remove/
 *                         get_role_members/set_role_position/set_role_icon
 *     moderation      1   get_audit_log
 *     screening       2   get_membership_screening/update_membership_screening
 *     stats           1   get_server_stats
 *     forums          10  get_forum_channels/create_forum_channel/
 *                         create_forum_post/get_forum_post/list_forum_threads/
 *                         reply_to_forum/delete_forum_post/get_forum_tags/
 *                         set_forum_tags/update_forum_post
 *     webhooks        8   create/send_message/edit/delete/list/edit_message/
 *                         delete_message/fetch_message
 *     scheduledEvents 7   list/get/create/edit/delete/get_subscribers/
 *                         create_event_invite
 *     invites         5   list/get/create/delete/list_channel_invites
 *     dm              7   send/send_embed/edit/edit_embed/delete/read/reply
 *
 *   Tool-registration pattern (per `src/tools/types.ts` + per-module files):
 *     - Each module exports a `definitions: ToolDefinition[]` array whose
 *       entries look like
 *         { name: 'discord_<verb>_<noun>', description: '...', inputSchema: {...} }
 *     - `src/tools/index.ts` collects all modules into a `modules: ToolModule[]`
 *       array and routes via linear search through their `handle()` functions.
 *
 *   Detection signals chosen:
 *     1. `package.json` `name` field equals (or contains) `@pasympa/discord-mcp`
 *        OR matches `/pasympa/i` (covers forks that namespace under a
 *        different scope).
 *     2. AND content match: at least one `*.ts` file under `src/tools/`
 *        contains a `'discord_<x>'` literal. Single signal alone is too
 *        weak: any TypeScript repo could happen to match `pasympa` in its
 *        name, and many community Discord MCPs use the `discord_` prefix.
 *
 *   Known mapping ambiguities (see NAME_MAP `notes` for per-tool detail):
 *     - PaSympa exposes embed-specific helpers (`discord_send_embed`,
 *       `discord_edit_embed`, `discord_send_multiple_embeds`) that fold
 *       into discord-mcp's general `messages_send` / `messages_edit` -
 *       confidence: medium because args differ.
 *     - PaSympa's `discord_get_message_with_context` is a context-window
 *       fetch; nearest discord-mcp equivalent is `messages_read` (which
 *       takes a `limit` and a `before/after` anchor). Confidence: medium.
 *     - PaSympa lumps timeouts into `members` (`discord_timeout_member`)
 *       which discord-mcp models via `members_modify` (the underlying
 *       Discord REST patches `communication_disabled_until`). Confidence:
 *       medium - caller must supply the timestamp.
 *     - PaSympa's "permissions" module overlays the channel-permissions
 *       REST surface that discord-mcp exposes as
 *       `channels_modify_permissions` / `channels_delete_permissions`.
 *       Confidence: medium for the set/reset variants.
 *     - PaSympa surfaces "audit_permissions" / "copy_permissions" as
 *       higher-level helpers with no 1:1 discord-mcp equivalent - left
 *       unmapped (caller composes from `channels_modify_permissions`).
 *     - PaSympa's `dm` helpers wrap `users_create_dm` + `messages_send`
 *       under one tool. We map `discord_send_dm` to `messages_send` with
 *       confidence: low and a note pointing at `users_create_dm`.
 *     - `discord_get_server_stats` has no discord-mcp equivalent (PaSympa
 *       computes it client-side from member/channel counts) - unmapped.
 *
 *   Tools deliberately left out of NAME_MAP:
 *     - High-level helpers without a 1:1 discord-mcp tool:
 *         discord_audit_permissions, discord_copy_permissions,
 *         discord_get_server_stats, discord_clone_channel.
 *     - Anything where the discord-mcp surface requires a fundamentally
 *       different argument shape that can't be auto-translated.
 *
 *   The adapter is best-effort. Users running it against a real PaSympa
 *   tree should treat the report as a starting point and verify each
 *   `medium` / `low` entry against the destination tool's input schema
 *   before deleting the source code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MappedTool, MigrationResult, MigrationSource } from './types.js';

/**
 * Confidence-tagged map from PaSympa tool name → discord-mcp tool name.
 *
 *   high   - name + arg shape are a 1:1 match (verified against the
 *            discord-mcp tool definitions under `packages/mcp-core/src/tools/`).
 *   medium - name maps cleanly but the caller may need to massage args.
 *   low    - best-guess mapping; user MUST verify before use.
 *
 * Entries WITHOUT a discord-mcp equivalent (e.g. `discord_audit_permissions`,
 * `discord_get_server_stats`) are intentionally absent - `migrate()` will
 * report them under `unmappedTools` so the user sees what didn't translate.
 */
const NAME_MAP: Record<
  string,
  { mapped: string; confidence: 'high' | 'medium' | 'low'; notes?: string }
> = {
  // discovery
  discord_list_guilds: { mapped: 'users_list_current_user_guilds', confidence: 'high' },
  discord_get_guild_info: { mapped: 'guild_get', confidence: 'high' },
  discord_list_channels: { mapped: 'channels_list', confidence: 'high' },
  discord_find_channel_by_name: {
    mapped: 'channels_list',
    confidence: 'medium',
    notes: 'discord-mcp has no by-name finder; list and filter client-side',
  },

  // messages
  discord_send_message: { mapped: 'messages_send', confidence: 'high' },
  discord_read_messages: { mapped: 'messages_read', confidence: 'high' },
  discord_reply_message: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'pass message_reference.message_id in the send payload',
  },
  discord_edit_message: { mapped: 'messages_edit', confidence: 'high' },
  discord_delete_message: { mapped: 'messages_delete', confidence: 'high' },
  discord_pin_message: { mapped: 'messages_pin', confidence: 'high' },
  discord_bulk_delete_messages: { mapped: 'messages_bulk_delete', confidence: 'high' },
  discord_crosspost_message: { mapped: 'messages_crosspost', confidence: 'high' },
  discord_search_messages: { mapped: 'messages_search_recent', confidence: 'high' },
  discord_fetch_pinned_messages: { mapped: 'messages_list_pins', confidence: 'high' },
  discord_create_thread: { mapped: 'messages_create_thread', confidence: 'high' },
  discord_add_reaction: { mapped: 'reactions_create', confidence: 'high' },
  discord_remove_reactions: { mapped: 'reactions_delete_all', confidence: 'high' },
  discord_get_reactions: { mapped: 'reactions_list', confidence: 'high' },
  discord_send_embed: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'embed becomes embeds[] in messages_send payload',
  },
  discord_edit_embed: {
    mapped: 'messages_edit',
    confidence: 'medium',
    notes: 'embed becomes embeds[] in messages_edit payload',
  },
  discord_send_multiple_embeds: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'pass embeds[] directly in messages_send payload',
  },
  discord_forward_message: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'discord-mcp has no first-class forward; copy content + use message_reference',
  },

  // channels
  discord_create_channel: { mapped: 'channels_create_guild_channel', confidence: 'high' },
  discord_delete_channel: { mapped: 'channels_delete', confidence: 'high' },
  discord_edit_channel: { mapped: 'channels_modify', confidence: 'high' },
  discord_move_channel: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'set parent_id and/or position via channels_modify',
  },
  discord_set_channel_position: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass position via channels_modify',
  },
  discord_follow_announcement_channel: {
    mapped: 'channels_follow_announcement',
    confidence: 'high',
  },
  discord_lock_channel_permissions: {
    mapped: 'channels_modify_permissions',
    confidence: 'medium',
    notes: 'lock = explicit deny overwrite for @everyone via channels_modify_permissions',
  },

  // permissions
  discord_get_channel_permissions: {
    mapped: 'channels_get',
    confidence: 'medium',
    notes: 'discord-mcp returns the full channel; permission_overwrites is on it',
  },
  discord_set_role_permission: { mapped: 'channels_modify_permissions', confidence: 'high' },
  discord_set_member_permission: { mapped: 'channels_modify_permissions', confidence: 'high' },
  discord_reset_channel_permissions: {
    mapped: 'channels_delete_permissions',
    confidence: 'high',
  },

  // members
  discord_list_members: { mapped: 'members_list', confidence: 'high' },
  discord_get_member_info: { mapped: 'members_get', confidence: 'high' },
  discord_kick_member: { mapped: 'members_kick', confidence: 'high' },
  discord_ban_member: { mapped: 'members_ban', confidence: 'high' },
  discord_unban_member: { mapped: 'members_unban', confidence: 'high' },
  discord_search_members: { mapped: 'members_search', confidence: 'high' },
  discord_list_bans: { mapped: 'members_list_bans', confidence: 'high' },
  discord_bulk_ban: { mapped: 'members_bulk_ban', confidence: 'high' },
  discord_timeout_member: {
    mapped: 'members_modify',
    confidence: 'medium',
    notes: 'set communication_disabled_until via members_modify',
  },
  discord_set_nickname: {
    mapped: 'members_modify',
    confidence: 'medium',
    notes: 'set nick via members_modify (or members_modify_current for self)',
  },
  discord_prune_members: {
    mapped: 'guild_begin_prune',
    confidence: 'high',
    notes: 'use guild_get_prune_count first to preview',
  },

  // roles
  discord_list_roles: { mapped: 'roles_list', confidence: 'high' },
  discord_create_role: { mapped: 'roles_create', confidence: 'high' },
  discord_edit_role: { mapped: 'roles_modify', confidence: 'high' },
  discord_delete_role: { mapped: 'roles_delete', confidence: 'high' },
  discord_add_role: { mapped: 'members_add_role', confidence: 'high' },
  discord_remove_role: { mapped: 'members_remove_role', confidence: 'high' },
  discord_set_role_position: { mapped: 'roles_modify_positions', confidence: 'high' },
  discord_set_role_icon: {
    mapped: 'roles_modify',
    confidence: 'medium',
    notes: 'pass icon (base64) or unicode_emoji via roles_modify',
  },
  discord_get_role_members: {
    mapped: 'members_list',
    confidence: 'low',
    notes: 'discord-mcp has no by-role lookup; list members and filter on role IDs',
  },

  // moderation
  discord_get_audit_log: { mapped: 'audit_log_get', confidence: 'high' },

  // screening
  discord_get_membership_screening: {
    mapped: 'guild_get_welcome_screen',
    confidence: 'low',
    notes:
      'PaSympa screening uses /guilds/:id/member-verification (a different surface than welcome_screen); verify before using',
  },
  discord_update_membership_screening: {
    mapped: 'guild_modify_welcome_screen',
    confidence: 'low',
    notes: 'see note on discord_get_membership_screening',
  },

  // forums
  discord_create_forum_channel: { mapped: 'channels_create_guild_channel', confidence: 'high' },
  discord_create_forum_post: { mapped: 'channels_forum_create_thread', confidence: 'high' },
  discord_list_forum_threads: {
    mapped: 'channels_list_active_threads_guild',
    confidence: 'medium',
  },
  discord_reply_to_forum: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'send to the forum thread channel ID',
  },
  discord_delete_forum_post: {
    mapped: 'channels_delete',
    confidence: 'medium',
    notes: 'delete the forum thread channel',
  },
  discord_set_forum_tags: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'available_tags is set on the parent forum channel via channels_modify',
  },
  discord_update_forum_post: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'forum thread state (locked/archived/applied_tags) is patched via channels_modify',
  },

  // webhooks
  discord_create_webhook: { mapped: 'webhooks_create', confidence: 'high' },
  discord_send_webhook_message: { mapped: 'webhooks_execute', confidence: 'high' },
  discord_edit_webhook: { mapped: 'webhooks_modify', confidence: 'high' },
  discord_delete_webhook: { mapped: 'webhooks_delete', confidence: 'high' },
  discord_list_webhooks: {
    mapped: 'webhooks_list_channel',
    confidence: 'medium',
    notes: 'or webhooks_list_guild - pick the right scope',
  },
  discord_edit_webhook_message: { mapped: 'webhooks_edit_message', confidence: 'high' },
  discord_delete_webhook_message: { mapped: 'webhooks_delete_message', confidence: 'high' },
  discord_fetch_webhook_message: { mapped: 'webhooks_get_message', confidence: 'high' },

  // invites
  discord_list_invites: {
    mapped: 'invites_list_channel',
    confidence: 'medium',
    notes: 'discord-mcp invites are scoped per-channel; iterate channels for guild-wide listing',
  },
  discord_get_invite: { mapped: 'invites_get', confidence: 'high' },
  discord_create_invite: { mapped: 'invites_create_channel', confidence: 'high' },
  discord_delete_invite: { mapped: 'invites_delete', confidence: 'high' },
  discord_list_channel_invites: { mapped: 'invites_list_channel', confidence: 'high' },

  // dm
  discord_send_dm: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'first call users_create_dm to get the DM channel ID, then messages_send',
  },
  discord_send_dm_embed: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'see discord_send_dm; pass embeds[] in payload',
  },
  discord_edit_dm: { mapped: 'messages_edit', confidence: 'medium' },
  discord_edit_dm_embed: { mapped: 'messages_edit', confidence: 'medium' },
  discord_delete_dm: { mapped: 'messages_delete', confidence: 'medium' },
  discord_read_dms: { mapped: 'messages_read', confidence: 'medium' },
  discord_reply_dm: {
    mapped: 'messages_send',
    confidence: 'low',
    notes: 'see discord_send_dm; add message_reference for reply',
  },
};

/**
 * Recursively walk `dir` returning every `*.ts` file (excluding
 * `*.test.ts`). Returns [] if `dir` is missing or unreadable - callers
 * surface the empty result via a `warnings` entry.
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

export const pasympaAdapter: MigrationSource = {
  id: 'pasympa',
  description: 'PaSympa Discord MCP server (TypeScript, ~91 tools, discord_* prefix)',
  homepage: 'https://github.com/PaSympa/discord-mcp',
  languages: ['typescript'],
  toolCountEstimate: 91,

  async detect(rootPath: string): Promise<boolean> {
    // Signal 1: package.json with PaSympa-shaped `name`. We accept the
    // exact upstream name and any name containing `pasympa` (catches
    // private forks). Failures (missing/unparseable package.json) short-
    // circuit to false - better to under-detect than false-positive on
    // every TypeScript repo.
    let nameMatches = false;
    try {
      const pkgPath = join(rootPath, 'package.json');
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string };
      if (typeof pkg.name === 'string') {
        const namePatterns = [/pasympa/i, /@pasympa\/discord-mcp/i];
        nameMatches = namePatterns.some((p) => p.test(pkg.name as string));
      }
    } catch {
      return false;
    }
    if (!nameMatches) {
      return false;
    }

    // Signal 2: at least one `*.ts` file under `src/tools/` contains a
    // `'discord_<x>'` literal. We don't require the directory itself -
    // a fork might rename it - but we DO require the prefix appearing
    // somewhere under `src/`.
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
        if (/['"]discord_[a-z_]+['"]/.test(content)) {
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

    // Walk src/tools/*.ts (recursive) and extract every `discord_<x>`
    // literal. We dedup as we go so a tool referenced from both its
    // module and `index.ts` only counts once.
    const scanDir = toolsDirExists ? toolsDir : join(rootPath, 'src');
    let files: string[] = [];
    try {
      files = readDirTsFiles(scanDir);
    } catch (e) {
      warnings.push(`could not scan ${scanDir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!toolsDirExists) {
      warnings.push(
        `src/tools/ not found under ${rootPath} - falling back to a recursive scan of src/`,
      );
    }

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Best-effort: matches `'discord_xxx'` or `"discord_xxx"` anywhere
      // in the file. PaSympa's tool definitions all use literal strings,
      // so this catches every entry without parsing TypeScript.
      const re = /['"](discord_[a-z_][a-z_0-9]*)['"]/g;
      for (const match of content.matchAll(re)) {
        const name = match[1];
        if (name !== undefined && !allTools.includes(name)) {
          allTools.push(name);
        }
      }
    }

    if (allTools.length === 0) {
      warnings.push('no discord_* tool names found - adapter may not match this PaSympa version');
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
      source: 'pasympa',
      sourcePath,
      mappedTools,
      unmappedTools,
      manualReview: [],
      warnings,
    };
  },
};
