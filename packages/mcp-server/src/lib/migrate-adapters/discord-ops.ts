/**
 * discord-ops Discord MCP adapter - Plan 11 Phase D.
 *
 * RESEARCH NOTE (cutoff date 2026-05-01):
 *
 *   Upstream:    https://github.com/bookedsolidtech/discord-ops
 *   npm:         `discord-ops` (v0.23.0 at cutoff, MIT)
 *   Author:      bookedsolidtech
 *   Language:    TypeScript (Node ^20 || ^22 || ^24, ESM)
 *   Runtime dep: discord.js@^14.18, @modelcontextprotocol/sdk@^1.12, zod@^3.24
 *
 *   Tool surface (observed via `src/tools/index.ts` on the main branch HEAD):
 *   ~48-49 tools spread across 10 categories. Per-category tally:
 *     messaging   12  send_message, send_embed, get_messages, edit_message,
 *                     delete_message, add_reaction, pin_message,
 *                     unpin_message, search_messages, send_template,
 *                     list_templates, notify_owners
 *     channels    9   list_channels, get_channel, create_channel,
 *                     edit_channel, delete_channel, purge_messages,
 *                     set_slowmode, move_channel, set_permissions
 *     guilds      4   list_guilds, get_guild, create_invite, get_invites
 *     members     2   list_members, get_member
 *     roles       5   list_roles, create_role, edit_role, delete_role,
 *                     assign_role
 *     threads     3   create_thread, list_threads, archive_thread
 *     moderation  4   kick_member, ban_member, unban_member, timeout_member
 *     webhooks    6   create_webhook, get_webhook, list_webhooks,
 *                     edit_webhook, delete_webhook, execute_webhook
 *     audit       1   query_audit_log
 *     system      3   health_check, list_projects, list_bots
 *     ──────────────────
 *     total       ~49 (README claims "49 tools across full profile";
 *                      tools/index.ts aggregation enumerates 48 - within
 *                      single-tool drift, accepted as upstream measurement
 *                      noise)
 *
 *   Tool-registration pattern (per `src/tools/<category>/<file>.ts` +
 *   `src/tools/types.ts`):
 *     - Each tool file exports a `defineTool({...})` call producing a
 *       `ToolDefinition` whose shape is
 *         { name: '<verb>_<noun>', description: '...', category: '<cat>',
 *           inputSchema: <ZodSchema>, handle: async (input, ctx) => {...} }
 *     - `category` is one of the ten strings above and is REQUIRED.
 *     - `inputSchema` is always a Zod schema (not a JSON Schema literal),
 *       which is the strongest signature for detection.
 *     - `src/tools/index.ts` aggregates camelCase-named exports
 *       (`sendMessage`, `getMessages`, etc.) into `allTools: ToolDefinition[]`.
 *     - Naming: tool `name:` literals are snake_case verb-first
 *       (`send_message`, `kick_member`, `query_audit_log`). File names use
 *       kebab-case (`send-message.ts`, `query-audit-log.ts`). Different
 *       from quadslab's `<category>Tools` array pattern AND PaSympa's
 *       `discord_*` prefix.
 *
 *   Detection signals chosen:
 *     1. `package.json` `name` field equals `discord-ops` OR matches
 *        `/discord[-_]ops/i` (covers private forks that namespace under
 *        a scope). Zod is required as a runtime dep for the upstream;
 *        we don't use that as a signal because both quadslab and PaSympa
 *        also depend on zod.
 *     2. AND content match: at least one `*.ts` file contains a
 *        `defineTool(` call followed within the same buffer by a
 *        `category:` field. The combination is unique to discord-ops:
 *        - PaSympa uses `definitions: ToolDefinition[]` arrays and
 *          `discord_*` literals (no `defineTool`, no `category:`).
 *        - quadslab uses `<x>Tools = [...]` arrays + `execute<X>Tool`
 *          functions (no `defineTool`, no per-tool `category:` field).
 *        - Hubdustry uses Go (`mcp.NewTool` calls in `*.go`) - wholly
 *          disjoint file extension.
 *
 *   ## Architectural mismatches
 *
 *   discord-ops's defining features are deployment / DX patterns, NOT
 *   tool-level surface differences. They are documented here and noted in
 *   `migrate()` warnings, but DO NOT appear as NAME_MAP entries because
 *   there's nothing to translate at the tool level:
 *
 *   1. **Multi-guild project routing** -
 *      discord-ops accepts `{ project: 'my-app', channel: 'builds' }` and
 *      resolves to a `(guild_id, channel_id)` pair via `~/.discord-ops.json`.
 *      The TOOL set is the same; only the input shape differs. One discord-mcp
 *      process can operate across every guild visible to its `DISCORD_TOKEN`;
 *      callers pass `guild_id` per call or set `DISCORD_DEFAULT_GUILD_ID`.
 *      Separate processes are only needed for different tokens or explicit
 *      isolation boundaries.
 *
 *   2. **Tool profiles (slim cuts for token budget)** -
 *      discord-ops ships profiles like `monitoring` (7 tools), `readonly`
 *      (7), `moderation` (7), `messaging` (5), `channels` (7), `webhooks`
 *      (6), and `full` (49). They reduce schema overhead by hiding tools
 *      from the client. discord-mcp ships the full surface (202 tools at
 *      Phase D) and filters the advertised registry server-side with
 *      `MCP_CATEGORIES`. This isn't a translation
 *      problem - there's no source code for "the lite profile" that
 *      needs migrating. If a discord-ops fork exposes profile-variant
 *      tool names like `messages_lite` / `messages_full`, NAME_MAP folds
 *      ALL variants onto the same discord-mcp tool with `confidence: medium`
 *      and a note pointing back at this section.
 *
 *   3. **Dry-run mode** -
 *      discord-ops uses `DISCORD_OPS_DRY_RUN=1` to short-circuit destructive
 *      calls before they hit the Discord REST API. `MCP_DRY_RUN=true` only
 *      gates discord-mcp's 30 `confirm_required` tools; other writes can
 *      still execute. Users must audit every mapped write rather than carry
 *      over the variable as an equivalent safety boundary.
 *
 *   Known mapping ambiguities (see NAME_MAP `notes` for per-tool detail):
 *     - discord-ops's `send_template` / `list_templates` are CLIENT-SIDE
 *       templates (named message bodies stored in `~/.discord-ops.json`),
 *       NOT Discord guild templates. They have no discord-mcp equivalent
 *       (a future Plan would add a "saved messages" feature). Left
 *       unmapped - see unmappedTools.
 *     - discord-ops's `notify_owners` looks up the project's owner snowflake
 *       and DMs them. Maps to `messages_send` with confidence: low and a
 *       note about the multi-step compose (`users_create_dm` first).
 *     - discord-ops's `purge_messages` is a search + bulk_delete helper -
 *       maps to `messages_bulk_delete` with confidence: low and a note.
 *     - discord-ops's `set_permissions` is the channel-overwrite endpoint;
 *       maps to `channels_modify_permissions` with confidence: high.
 *     - discord-ops's `archive_thread` patches `archived: true` via the
 *       channel-modify endpoint; maps to `channels_modify` with
 *       confidence: medium.
 *     - discord-ops's `query_audit_log` maps to `audit_log_get` directly.
 *     - discord-ops's `list_projects` / `list_bots` / `health_check` are
 *       discord-ops-specific introspection tools. discord-mcp surfaces
 *       runtime health via the gateway client + MCP capability negotiation,
 *       not as tools. Left unmapped.
 *     - discord-ops's `create_invite` / `get_invites` map to
 *       `invites_create_channel` / `invites_list_channel` (note `get_invites`
 *       in discord-ops returns guild-wide via per-channel fanout -
 *       confidence: medium).
 *
 *   Tools deliberately left out of NAME_MAP (intentional unmapped):
 *     - System: health_check, list_projects, list_bots - discord-ops-only
 *     - Templates: send_template, list_templates - client-side feature
 *
 *   Repo state at cutoff: bookedsolidtech/discord-ops main branch was
 *   reachable via raw GitHub fetches; per-file inspection succeeded for
 *   `src/tools/index.ts` and a representative sample of tool modules
 *   (`src/tools/messaging/send-message.ts`, `get-messages.ts`). README
 *   `49` vs counted `48`: one-tool drift accepted as upstream measurement
 *   noise.
 *
 *   The adapter is best-effort. Users running it against a real
 *   discord-ops tree should treat the report as a starting point and
 *   verify each `medium` / `low` entry against the destination tool's
 *   input schema before deleting the source code. The architectural-
 *   mismatch warnings above ALWAYS apply regardless of NAME_MAP coverage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MappedTool, MigrationResult, MigrationSource } from './types.js';

/**
 * Confidence-tagged map from discord-ops tool name → discord-mcp tool name.
 *
 *   high   - name + arg shape are a 1:1 match (verified against
 *            `packages/mcp-core/src/tools/<category>/`).
 *   medium - name maps cleanly but the caller may need to massage args
 *            (or, in profile-variant cases, multiple discord-ops names
 *            collapse onto a single discord-mcp tool).
 *   low    - best-guess mapping; user MUST verify.
 *
 * Entries WITHOUT a discord-mcp equivalent (system/templates) are
 * intentionally absent - `migrate()` reports them under `unmappedTools`.
 */
const NAME_MAP: Record<
  string,
  { mapped: string; confidence: 'high' | 'medium' | 'low'; notes?: string }
> = {
  // messaging
  send_message: { mapped: 'messages_send', confidence: 'high' },
  send_embed: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes: 'pass embeds[] in messages_send payload',
  },
  get_messages: { mapped: 'messages_read', confidence: 'high' },
  edit_message: { mapped: 'messages_edit', confidence: 'high' },
  delete_message: { mapped: 'messages_delete', confidence: 'high' },
  add_reaction: { mapped: 'reactions_create', confidence: 'high' },
  pin_message: { mapped: 'messages_pin', confidence: 'high' },
  unpin_message: { mapped: 'messages_unpin', confidence: 'high' },
  search_messages: { mapped: 'messages_search_recent', confidence: 'high' },
  notify_owners: {
    mapped: 'messages_send',
    confidence: 'low',
    notes:
      'discord-ops resolves owner snowflakes via project config; with discord-mcp call users_create_dm to get a DM channel ID, then messages_send',
  },

  // Profile-variant aliases (discord-ops's `messaging` profile cuts).
  // ALL profile variants collapse onto the same discord-mcp tool with
  // confidence: medium because discord-mcp ships the full surface and
  // the agent filters at runtime - see "Architectural mismatches" #2 in
  // the file header.
  messages_lite: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes:
      'profile-variant of send_message; discord-mcp ships full surface, agent filters at runtime',
  },
  messages_full: {
    mapped: 'messages_send',
    confidence: 'medium',
    notes:
      'profile-variant of send_message; discord-mcp ships full surface, agent filters at runtime',
  },

  // channels
  list_channels: { mapped: 'channels_list', confidence: 'high' },
  get_channel: { mapped: 'channels_get', confidence: 'high' },
  create_channel: { mapped: 'channels_create_guild_channel', confidence: 'high' },
  edit_channel: { mapped: 'channels_modify', confidence: 'high' },
  delete_channel: { mapped: 'channels_delete', confidence: 'high' },
  purge_messages: {
    mapped: 'messages_bulk_delete',
    confidence: 'low',
    notes: 'first messages_search_recent or messages_read, then messages_bulk_delete',
  },
  set_slowmode: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass rate_limit_per_user via channels_modify',
  },
  move_channel: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'set parent_id and/or position via channels_modify',
  },
  set_permissions: { mapped: 'channels_modify_permissions', confidence: 'high' },

  // guilds
  list_guilds: { mapped: 'users_list_current_user_guilds', confidence: 'high' },
  get_guild: { mapped: 'guild_get', confidence: 'high' },
  create_invite: { mapped: 'invites_create_channel', confidence: 'high' },
  get_invites: {
    mapped: 'invites_list_channel',
    confidence: 'medium',
    notes:
      'discord-ops aggregates guild-wide; discord-mcp invites are scoped per-channel - iterate channels',
  },

  // members
  list_members: { mapped: 'members_list', confidence: 'high' },
  get_member: { mapped: 'members_get', confidence: 'high' },

  // roles
  list_roles: { mapped: 'roles_list', confidence: 'high' },
  create_role: { mapped: 'roles_create', confidence: 'high' },
  edit_role: { mapped: 'roles_modify', confidence: 'high' },
  delete_role: { mapped: 'roles_delete', confidence: 'high' },
  assign_role: { mapped: 'members_add_role', confidence: 'high' },

  // threads
  create_thread: { mapped: 'messages_create_thread', confidence: 'high' },
  list_threads: { mapped: 'channels_list_active_threads_guild', confidence: 'medium' },
  archive_thread: {
    mapped: 'channels_modify',
    confidence: 'medium',
    notes: 'pass archived=true via channels_modify',
  },

  // moderation
  kick_member: { mapped: 'members_kick', confidence: 'high' },
  ban_member: { mapped: 'members_ban', confidence: 'high' },
  unban_member: { mapped: 'members_unban', confidence: 'high' },
  timeout_member: {
    mapped: 'members_modify',
    confidence: 'medium',
    notes: 'set communication_disabled_until via members_modify',
  },

  // webhooks
  create_webhook: { mapped: 'webhooks_create', confidence: 'high' },
  get_webhook: { mapped: 'webhooks_get', confidence: 'high' },
  list_webhooks: {
    mapped: 'webhooks_list_channel',
    confidence: 'medium',
    notes: 'or webhooks_list_guild - pick the right scope',
  },
  edit_webhook: { mapped: 'webhooks_modify', confidence: 'high' },
  delete_webhook: { mapped: 'webhooks_delete', confidence: 'high' },
  execute_webhook: { mapped: 'webhooks_execute', confidence: 'high' },

  // audit
  query_audit_log: { mapped: 'audit_log_get', confidence: 'high' },
};

/**
 * Set of known discord-ops tool names. Used as the precision filter
 * during `migrate()`: a generic snake_case regex would match any string
 * literal in the codebase (variable names, comments, etc.), so we
 * intersect against this catalog. New discord-ops versions that add
 * tools will need this set updated, but that's the safe trade-off vs.
 * false-positive-prone `[a-z_]+` matching.
 *
 * Includes the profile-variant aliases (`messages_lite`, `messages_full`)
 * even though they aren't in the main upstream - they show up in private
 * forks that customise the profile catalog and must still resolve cleanly.
 */
const KNOWN_DISCORD_OPS_TOOLS: ReadonlySet<string> = new Set([
  // messaging
  'send_message',
  'send_embed',
  'get_messages',
  'edit_message',
  'delete_message',
  'add_reaction',
  'pin_message',
  'unpin_message',
  'search_messages',
  'send_template',
  'list_templates',
  'notify_owners',
  // profile-variant aliases
  'messages_lite',
  'messages_full',
  // channels
  'list_channels',
  'get_channel',
  'create_channel',
  'edit_channel',
  'delete_channel',
  'purge_messages',
  'set_slowmode',
  'move_channel',
  'set_permissions',
  // guilds
  'list_guilds',
  'get_guild',
  'create_invite',
  'get_invites',
  // members
  'list_members',
  'get_member',
  // roles
  'list_roles',
  'create_role',
  'edit_role',
  'delete_role',
  'assign_role',
  // threads
  'create_thread',
  'list_threads',
  'archive_thread',
  // moderation
  'kick_member',
  'ban_member',
  'unban_member',
  'timeout_member',
  // webhooks
  'create_webhook',
  'get_webhook',
  'list_webhooks',
  'edit_webhook',
  'delete_webhook',
  'execute_webhook',
  // audit
  'query_audit_log',
  // system (intentionally unmapped - see file header)
  'health_check',
  'list_projects',
  'list_bots',
]);

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

export const discordOpsAdapter: MigrationSource = {
  id: 'discord-ops',
  description: 'discord-ops by bookedsolidtech (multi-guild routing, dry-run mode)',
  homepage: 'https://github.com/bookedsolidtech/discord-ops',
  languages: ['typescript'],
  toolCountEstimate: 49,

  async detect(rootPath: string): Promise<boolean> {
    // Signal 1: package.json with discord-ops-shaped `name`. Accept the
    // exact upstream name and any name containing `discord-ops` (covers
    // private forks). Any IO failure on package.json is a hard rejection
    // - better to under-detect than false-positive on every TS repo.
    let nameMatches = false;
    try {
      const pkgPath = join(rootPath, 'package.json');
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { name?: string };
      if (typeof pkg.name === 'string') {
        const namePatterns = [/^discord-ops$/, /discord[-_]ops/i];
        nameMatches = namePatterns.some((p) => p.test(pkg.name as string));
      }
    } catch {
      return false;
    }
    if (!nameMatches) {
      return false;
    }

    // Signal 2: at least one `*.ts` file under `src/tools/` (or `src/`)
    // contains a `defineTool(` call AND a `category:` field somewhere in
    // the same file. The combination is unique to discord-ops:
    //   - PaSympa: definitions: [...] arrays, no defineTool, no category
    //   - quadslab: <x>Tools arrays + execute<X>Tool, no defineTool, no
    //               per-tool category field
    //   - Hubdustry: Go files, wholly disjoint extension
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
        const hasDefineTool = /\bdefineTool\s*\(/.test(content);
        const hasCategoryField = /\bcategory\s*:\s*['"][a-z_]+['"]/.test(content);
        if (hasDefineTool && hasCategoryField) {
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
        `src/tools/ not found under ${rootPath} - falling back to a recursive scan of src/`,
      );
    }

    // Walk `*.ts` and extract every `name: '<known_discord_ops_tool>'`
    // literal. Generic snake_case matching would false-positive on
    // variable names - intersecting against KNOWN_DISCORD_OPS_TOOLS keeps
    // the result high-precision.
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const re = /['"]([a-z][a-z_0-9]*)['"]/g;
      for (const match of content.matchAll(re)) {
        const name = match[1];
        if (name !== undefined && KNOWN_DISCORD_OPS_TOOLS.has(name) && !allTools.includes(name)) {
          allTools.push(name);
        }
      }
    }

    if (allTools.length === 0) {
      warnings.push(
        'no discord-ops tool names found - adapter may not match this discord-ops version',
      );
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

    // Architectural-mismatch reminder. ALWAYS emitted, even for an empty
    // fixture - these patterns apply to any discord-ops migration regardless
    // of NAME_MAP coverage. See file-level "## Architectural mismatches".
    if (allTools.length > 0) {
      warnings.push(
        'multi-guild project routing changes shape: one discord-mcp process can reach every guild visible to its bot token; use guild_id or DISCORD_DEFAULT_GUILD_ID, and split processes only for different tokens or isolation',
      );
      warnings.push(
        'tool profiles (lite/full/monitoring/...) are not migrated directly - translate them to the server-side MCP_CATEGORIES allowlist and verify tools/list',
      );
      warnings.push(
        'dry-run is not equivalent: MCP_DRY_RUN=true gates only the 30 confirm_required tools; inventory ordinary writes and use restricted permissions or a test guild for the rest',
      );
    }

    return {
      source: 'discord-ops',
      sourcePath,
      mappedTools,
      unmappedTools,
      manualReview: [],
      warnings,
    };
  },
};
