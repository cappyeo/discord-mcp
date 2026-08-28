import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { z } from 'zod';
import {
  BotScopeUnresolvedError,
  GuildNotAllowedError,
  GuildScopeUnresolvedError,
} from '../errors/client.js';
import { resolveChannelGuildId } from '../rest/channel-guild-cache.js';
import type { ToolMiddleware } from './compose.js';

interface SchemaCarrier {
  readonly inputSchema: Record<string, z.ZodTypeAny>;
}

interface GuildWebhook {
  readonly guild_id?: string;
  readonly channel_id?: string | null;
}

interface GuildInvite {
  readonly guild?: { readonly id: string };
}

interface GuildSticker {
  readonly guild_id?: string;
}

const CHANNEL_FIELDS = [
  'channel_id',
  'thread_id',
  'webhook_channel_id',
  'parent_id',
  'afk_channel_id',
  'system_channel_id',
  'rules_channel_id',
  'public_updates_channel_id',
  'safety_alerts_channel_id',
] as const;
const CHANNEL_ARRAY_FIELDS = ['default_channel_ids'] as const;
const MAX_RESOLUTION_CACHE_ENTRIES = 1_024;

/**
 * Operations whose Discord route is global or authenticated only by an opaque
 * interaction token. With an active guild allowlist, the server cannot prove
 * their target guild before execution, so they fail closed and stay hidden.
 * Bot-scoped application routes are handled below through the exact expected
 * bot identity; routes that also carry a guild target continue through the
 * guild check after identity validation.
 */
export const GUILD_SCOPE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'app_emojis_list',
  'app_emojis_get',
  'app_emojis_create',
  'app_emojis_modify',
  'app_emojis_delete',
  'application_modify_current',
  'application_get_current',
  'application_get_activity_instance',
  'application_get_role_connection_metadata',
  'application_modify_role_connection_metadata',
  'commands_create_global',
  'commands_modify_global',
  'commands_delete_global',
  'commands_bulk_overwrite_global',
  'commands_list_global',
  'commands_get_global',
  'entitlements_consume',
  'entitlements_create_test',
  'entitlements_delete_test',
  'entitlements_get',
  'skus_list',
  'subscriptions_list',
  'subscriptions_get',
  'interactions_create_followup',
  'interactions_create_response',
  'interactions_delete_followup',
  'interactions_delete_original_response',
  'interactions_edit_followup',
  'interactions_edit_original_response',
  'interactions_get_followup',
  'interactions_get_original_response',
  'users_create_dm',
  'users_modify_current',
]);

/**
 * Application-scoped operations are safe to expose alongside a guild allowlist
 * only after the deployment has locked the credential to one expected bot
 * identity. Global routes can affect every guild where the application is
 * available, so they still target only that bot's application; this is not a
 * general cross-application write escape.
 */
export const BOT_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  'app_emojis_list',
  'app_emojis_get',
  'app_emojis_create',
  'app_emojis_modify',
  'app_emojis_delete',
  // Application commands carry an application_id in every route. Locking
  // that value to the authenticated bot prevents a guild allowlist from
  // becoming an accidental cross-application control plane.
  'commands_bulk_overwrite_global',
  'commands_create_global',
  'commands_delete_global',
  'commands_modify_global',
  'commands_list_global',
  'commands_get_global',
  'commands_bulk_overwrite_guild',
  'commands_create_guild',
  'commands_delete_guild',
  'commands_modify_guild',
  'commands_list_guild',
  'commands_get_guild',
  'application_get_activity_instance',
  'application_get_current',
  'application_modify_current',
  'application_get_role_connection_metadata',
  'application_modify_role_connection_metadata',
  'skus_list',
  'subscriptions_list',
  'subscriptions_get',
  'entitlements_list',
  'entitlements_get',
  'entitlements_consume',
  'entitlements_create_test',
  'entitlements_delete_test',
  'commands_get_command_permissions',
  'commands_get_guild_command_permissions',
  'users_modify_current',
]);
const USER_SCOPED_TOOLS: ReadonlySet<string> = new Set(['users_create_dm']);

export function parseGuildAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  return new Set(raw.split(',').map((guildId) => guildId.trim()));
}

export function isToolVisibleWithGuildAllowlist(
  toolName: string,
  enabled: boolean,
  expectedBotId?: string,
  allowUserScoped = false,
): boolean {
  if (!enabled || !GUILD_SCOPE_BLOCKED_TOOLS.has(toolName)) return true;
  if (USER_SCOPED_TOOLS.has(toolName)) return allowUserScoped && expectedBotId !== undefined;
  return BOT_SCOPED_TOOLS.has(toolName) && expectedBotId !== undefined;
}

export function hasVerifiableGuildScope(
  toolName: string,
  inputSchema: Readonly<Record<string, unknown>>,
): boolean {
  if (toolName === 'mcp_pipeline' || GUILD_SCOPE_BLOCKED_TOOLS.has(toolName)) return true;
  if (Object.hasOwn(inputSchema, 'guild_id') || Object.hasOwn(inputSchema, 'webhook_id')) {
    return true;
  }
  if (CHANNEL_FIELDS.some((field) => Object.hasOwn(inputSchema, field))) return true;
  if (CHANNEL_ARRAY_FIELDS.some((field) => Object.hasOwn(inputSchema, field))) return true;
  if (toolName.startsWith('invites_') && Object.hasOwn(inputSchema, 'code')) return true;
  return toolName === 'stickers_get' && Object.hasOwn(inputSchema, 'sticker_id');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class GuildScopePolicy {
  private readonly webhookGuilds = new Map<string, Promise<string>>();
  private readonly inviteGuilds = new Map<string, Promise<string>>();
  private readonly stickerGuilds = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly allowed: ReadonlySet<string> | null,
    private readonly rest: REST,
    private readonly expectedBotId?: string,
    private readonly allowUserScoped = false,
  ) {}

  public get enabled(): boolean {
    return this.allowed !== null;
  }

  public assertGuild(guildId: string): void {
    if (this.allowed !== null && !this.allowed.has(guildId)) {
      throw new GuildNotAllowedError(guildId);
    }
  }

  public async authorizeTool(
    toolName: string,
    argsValue: unknown,
    schema: SchemaCarrier | undefined,
  ): Promise<void> {
    if (USER_SCOPED_TOOLS.has(toolName)) {
      if (this.allowed === null) return;
      if (!this.allowUserScoped || this.expectedBotId === undefined) {
        throw new GuildScopeUnresolvedError(
          `user-scoped tool ${toolName} (MCP_ALLOW_USER_SCOPED=true and DISCORD_EXPECTED_BOT_ID are required)`,
        );
      }
      this.authorizeBotScopedTool(toolName, argsValue);
      return;
    }
    // An identity lock is authoritative for bot-scoped application operations
    // even when no guild allowlist is configured. This prevents an explicit
    // application_id from silently widening the operation to another app.
    if (BOT_SCOPED_TOOLS.has(toolName)) {
      this.authorizeBotScopedTool(toolName, argsValue);
      // Global application routes have no guild target. After the identity
      // check they are safe to pass through an active guild allowlist.
      if (GUILD_SCOPE_BLOCKED_TOOLS.has(toolName)) return;
    }
    if (this.allowed === null) return;
    if (GUILD_SCOPE_BLOCKED_TOOLS.has(toolName)) {
      throw new GuildScopeUnresolvedError(`tool ${toolName}`);
    }
    if (!isRecord(argsValue)) {
      throw new GuildScopeUnresolvedError(`tool ${toolName}`);
    }

    let checkedDirectGuild = false;
    if (schema !== undefined && Object.hasOwn(schema.inputSchema, 'guild_id')) {
      const guildId = stringField(argsValue, 'guild_id');
      if (guildId === undefined) {
        throw new GuildScopeUnresolvedError(`tool ${toolName}`);
      }
      this.assertGuild(guildId);
      checkedDirectGuild = true;
    }

    for (const field of CHANNEL_FIELDS) {
      const channelId = stringField(argsValue, field);
      if (channelId === undefined) continue;
      this.assertGuild(await this.resolveChannelGuild(channelId));
    }
    for (const field of CHANNEL_ARRAY_FIELDS) {
      const value = argsValue[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new GuildScopeUnresolvedError(`tool ${toolName}`);
      for (const channelId of value) {
        if (typeof channelId !== 'string' || channelId.length === 0) {
          throw new GuildScopeUnresolvedError(`tool ${toolName}`);
        }
        this.assertGuild(await this.resolveChannelGuild(channelId));
      }
    }

    const webhookId = stringField(argsValue, 'webhook_id');
    if (webhookId !== undefined) {
      const token = stringField(argsValue, 'token');
      this.assertGuild(await this.resolveWebhookGuild(webhookId, token));
    }

    if (toolName.startsWith('invites_')) {
      const code = stringField(argsValue, 'code');
      if (code !== undefined) {
        this.assertGuild(await this.resolveInviteGuild(code));
      }
    }

    if (toolName === 'stickers_get') {
      const stickerId = stringField(argsValue, 'sticker_id');
      if (stickerId === undefined) {
        throw new GuildScopeUnresolvedError(`tool ${toolName}`);
      }
      const guildId = await this.resolveStickerGuild(stickerId);
      if (guildId !== null) this.assertGuild(guildId);
      return;
    }

    if (checkedDirectGuild) return;

    // Global reads and local-only builders remain available. Their lack of a
    // guild target is intentional; unprovable writes are enumerated above.
  }

  private authorizeBotScopedTool(toolName: string, argsValue: unknown): void {
    if (this.expectedBotId === undefined) {
      throw new BotScopeUnresolvedError(
        `bot-scoped tool ${toolName} (DISCORD_EXPECTED_BOT_ID is required)`,
      );
    }
    if (!isRecord(argsValue)) {
      throw new BotScopeUnresolvedError(`bot-scoped tool ${toolName}`);
    }
    const applicationId = stringField(argsValue, 'application_id');
    if (applicationId !== undefined && applicationId !== this.expectedBotId) {
      throw new BotScopeUnresolvedError(
        `application ${applicationId} does not match the locked bot application ${this.expectedBotId}`,
      );
    }
  }

  public async authorizeSubscription(uri: string): Promise<void> {
    if (this.allowed === null) return;

    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new GuildScopeUnresolvedError(`resource ${uri}`);
    }
    if (parsed.protocol !== 'discord:') {
      throw new GuildScopeUnresolvedError(`resource ${uri}`);
    }

    const id = parsed.pathname.split('/').filter(Boolean)[0];
    if (parsed.hostname === 'components-v2') return;
    if (id === undefined) throw new GuildScopeUnresolvedError(`resource ${uri}`);
    if (parsed.hostname === 'guild' || parsed.hostname === 'voice') {
      this.assertGuild(id);
      return;
    }
    if (parsed.hostname === 'channel') {
      this.assertGuild(await this.resolveChannelGuild(id));
      return;
    }
    throw new GuildScopeUnresolvedError(`resource ${uri}`);
  }

  private cached<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    resolve: () => Promise<T>,
  ): Promise<T> {
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    if (cache.size >= MAX_RESOLUTION_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const pending = resolve().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }

  private resolveChannelGuild(channelId: string): Promise<string> {
    return resolveChannelGuildId(this.rest, channelId).then((guildId) => {
      if (guildId === undefined) {
        throw new GuildScopeUnresolvedError(`channel ${channelId}`);
      }
      return guildId;
    });
  }

  private resolveWebhookGuild(webhookId: string, token: string | undefined): Promise<string> {
    // Webhook IDs are globally unique and their guild cannot change. Key only
    // by ID so opaque webhook tokens are never retained in the policy cache.
    return this.cached(this.webhookGuilds, webhookId, async () => {
      const webhook = (await this.rest.get(
        Routes.webhook(webhookId, token),
        token === undefined ? undefined : { auth: false },
      )) as GuildWebhook;
      if (webhook.guild_id !== undefined) return webhook.guild_id;
      if (webhook.channel_id !== undefined && webhook.channel_id !== null) {
        return this.resolveChannelGuild(webhook.channel_id);
      }
      throw new GuildScopeUnresolvedError(`webhook ${webhookId}`);
    });
  }

  private resolveInviteGuild(code: string): Promise<string> {
    return this.cached(this.inviteGuilds, code, async () => {
      const invite = (await this.rest.get(Routes.invite(code))) as GuildInvite;
      if (invite.guild?.id === undefined) {
        throw new GuildScopeUnresolvedError(`invite ${code}`);
      }
      return invite.guild.id;
    });
  }

  private resolveStickerGuild(stickerId: string): Promise<string | null> {
    return this.cached(this.stickerGuilds, stickerId, async () => {
      const sticker = (await this.rest.get(Routes.sticker(stickerId))) as GuildSticker;
      return sticker.guild_id ?? null;
    });
  }
}

export function guildAllowlistMiddleware(policy: GuildScopePolicy): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      await policy.authorizeTool(
        ctx.tool.name,
        ctx.args,
        ctx.meta.get('toolPiece') as SchemaCarrier | undefined,
      );
      return next();
    },
  };
}
