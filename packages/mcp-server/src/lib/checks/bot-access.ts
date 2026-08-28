import type { BotChannelSnapshot, Config, GatewayIntentName } from '@discord-mcp/core';
import {
  DISCORD_PERMISSION_BITS,
  evaluateBotPermissions,
  listKnownToolAccessRequirements,
} from '@discord-mcp/core';
import type { DiscordMcpProfile } from '../profiles.js';
import type { CheckResult } from './index.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const PERMISSION_RE = /^\d+$/;
const REQUEST_TIMEOUT_MS = 8_000;
const INTENT_FLAGS: Readonly<
  Record<GatewayIntentName, { readonly approved: bigint; readonly limited: bigint }>
> = {
  GUILD_MEMBERS: { approved: 1n << 14n, limited: 1n << 15n },
  MESSAGE_CONTENT: { approved: 1n << 18n, limited: 1n << 19n },
};

type Fetcher = typeof fetch;

interface JsonResponse {
  readonly status: number;
  readonly value: unknown;
  readonly retryAfterSeconds: number | null;
}

interface RawUser {
  readonly id: string;
  readonly username?: string;
  readonly bot: boolean;
}

interface RawApplication {
  readonly id: string;
  readonly botId?: string;
  readonly flags?: unknown;
  readonly flags_new?: unknown;
}

export interface BotAccessOptions {
  readonly config: Config | null;
  readonly profile?: DiscordMcpProfile;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly fetcher?: Fetcher;
}

interface ToolAccessReport {
  readonly tool_name: string;
  readonly status:
    | 'ready'
    | 'missing_permissions'
    | 'missing_intents'
    | 'needs_channel'
    | 'bearer_required'
    | 'opaque_required'
    | 'consent_required'
    | 'delegated_required'
    | 'conditional'
    | 'identity_unlocked'
    | 'unknown';
  readonly scope: string;
  readonly auth: string;
  readonly required_permissions: readonly string[];
  readonly required_intents: readonly string[];
  readonly missing_permissions: readonly string[];
  readonly missing_intents: readonly string[];
  readonly reason?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function snowflake(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) {
    throw new Error(`Discord returned an invalid ${label}`);
  }
  return value;
}

function permissionString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PERMISSION_RE.test(value)) {
    throw new Error(`Discord returned an invalid ${label} permission bitfield`);
  }
  return value;
}

function baseUrl(): string {
  const configured = process.env.DISCORD_API_BASE_URL?.trim();
  const raw =
    configured === undefined || configured === '' ? 'https://discord.com/api/v10' : configured;
  return raw.replace(/\/$/u, '');
}

function authHeader(token: string): string {
  return `Bot ${token.startsWith('Bot ') ? token.slice(4) : token}`;
}

function safeStatusMessage(status: number, path: string): string {
  if (status === 401) return `${path} rejected the bot token (401)`;
  if (status === 403) return `${path} denied access (403)`;
  if (status === 404) return `${path} was not found (404)`;
  if (status === 429) return `${path} is rate limited (429)`;
  return `${path} returned HTTP ${status}`;
}

async function fetchJson(
  fetcher: Fetcher,
  base: string,
  path: string,
  token: string,
  signal: AbortSignal,
): Promise<JsonResponse> {
  const response = await fetcher(`${base}${path}`, {
    method: 'GET',
    headers: {
      Authorization: authHeader(token),
      'User-Agent': 'discord-mcp-doctor (https://github.com/cappyeo/discord-mcp)',
    },
    signal,
  });
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    // A status is still useful when Discord returns an empty or malformed body.
  }
  const retryAfterRaw = response.headers.get('retry-after');
  const retryAfter = retryAfterRaw === null ? Number.NaN : Number(retryAfterRaw);
  return {
    status: response.status,
    value,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
  };
}

function resolveGuildId(
  options: BotAccessOptions,
):
  | { readonly id: string }
  | { readonly warning: string; readonly id?: undefined }
  | { readonly error: string } {
  const explicit = options.guildId?.trim();
  const configured =
    options.profile?.allowedGuilds ??
    (() => {
      const raw = options.config?.ALLOWED_GUILDS;
      return raw === undefined
        ? options.config?.DISCORD_DEFAULT_GUILD_ID === undefined
          ? []
          : [options.config.DISCORD_DEFAULT_GUILD_ID]
        : raw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    })();

  if (explicit !== undefined && explicit !== '') {
    if (!SNOWFLAKE_RE.test(explicit))
      return { error: '--guild-id must be a 17-20 digit Discord snowflake' };
    if (configured.length > 0 && !configured.includes(explicit)) {
      return { error: `guild ${explicit} is outside the configured allowlist` };
    }
    return { id: explicit };
  }
  if (configured.length === 1 && configured[0] !== undefined) return { id: configured[0] };
  if (configured.length > 1) {
    return {
      warning: 'Multiple allowed guilds are configured; pass --guild-id to evaluate one target.',
    };
  }
  return {
    warning: 'No target guild is configured; identity is checked but guild access remains unknown.',
  };
}

function parseUser(value: unknown): RawUser {
  if (!isRecord(value)) throw new Error('Discord returned a malformed bot identity');
  const id = snowflake(value.id, 'bot ID');
  const username = stringValue(value.username);
  return username === undefined
    ? {
        id,
        bot: value.bot === true,
      }
    : {
        id,
        username,
        bot: value.bot === true,
      };
}

function parseApplication(value: unknown): RawApplication {
  if (!isRecord(value)) throw new Error('Discord returned a malformed application');
  const id = snowflake(value.id, 'application ID');
  let botId: string | undefined;
  if (value.bot !== undefined && value.bot !== null) {
    if (!isRecord(value.bot)) throw new Error('Discord returned a malformed application bot');
    botId = snowflake(value.bot.id, 'application bot ID');
  }
  return {
    id,
    ...(botId === undefined ? {} : { botId }),
    ...(value.flags === undefined ? {} : { flags: value.flags }),
    ...(value.flags_new === undefined ? {} : { flags_new: value.flags_new }),
  };
}

function parseMember(value: unknown, expectedBotId: string): { id: string; roles: string[] } {
  if (!isRecord(value) || !Array.isArray(value.roles)) {
    throw new Error('Discord returned a malformed guild bot member');
  }
  const user = isRecord(value.user) ? value.user : undefined;
  const id = snowflake(user?.id, 'guild bot member ID');
  if (id !== expectedBotId)
    throw new Error('Discord returned a different guild member than the bot');
  const roles = value.roles.map((roleId) => snowflake(roleId, 'guild member role ID'));
  return { id, roles };
}

function parseGuild(value: unknown, expectedGuildId: string): { id: string; ownerId?: string } {
  if (!isRecord(value)) throw new Error('Discord returned a malformed guild');
  const id = snowflake(value.id, 'guild ID');
  if (id !== expectedGuildId) throw new Error('Discord returned a different guild than requested');
  const result: { id: string; ownerId?: string } = { id };
  if (value.owner_id !== undefined) result.ownerId = snowflake(value.owner_id, 'guild owner ID');
  return result;
}

function parseRoles(value: unknown): Array<{
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
}> {
  if (!Array.isArray(value)) throw new Error('Discord returned a malformed guild role list');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.position !== 'number' ||
      !Number.isInteger(entry.position) ||
      typeof entry.name !== 'string' ||
      typeof entry.managed !== 'boolean'
    ) {
      throw new Error('Discord returned a malformed guild role');
    }
    return {
      id: snowflake(entry.id, 'role ID'),
      name: entry.name,
      position: entry.position,
      permissions: permissionString(entry.permissions, 'role'),
      managed: entry.managed,
    };
  });
}

function parseChannel(
  value: unknown,
  expectedChannelId: string,
  expectedGuildId: string,
): BotChannelSnapshot {
  if (!isRecord(value)) throw new Error('Discord returned a malformed channel');
  const id = snowflake(value.id, 'channel ID');
  if (id !== expectedChannelId)
    throw new Error('Discord returned a different channel than requested');
  if (value.guild_id !== expectedGuildId)
    throw new Error('The channel does not belong to the target guild');
  const channel: BotChannelSnapshot = {
    id,
    guild_id: expectedGuildId,
    type: typeof value.type === 'number' ? value.type : 0,
    parent_id: typeof value.parent_id === 'string' ? value.parent_id : null,
  };
  if (value.permission_overwrites !== undefined) {
    if (!Array.isArray(value.permission_overwrites)) {
      throw new Error('Discord returned malformed channel permission overwrites');
    }
    channel.permission_overwrites = value.permission_overwrites.map((overwrite) => {
      if (!isRecord(overwrite)) {
        throw new Error('Discord returned a malformed channel permission overwrite');
      }
      return {
        id: snowflake(overwrite.id, 'permission overwrite ID'),
        type: typeof overwrite.type === 'number' ? overwrite.type : 0,
        allow: permissionString(overwrite.allow, 'overwrite allow'),
        deny: permissionString(overwrite.deny, 'overwrite deny'),
      };
    });
  }
  return channel;
}

function parseBitfield(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function intentState(
  flags: bigint | null,
  intent: GatewayIntentName,
): 'approved' | 'limited' | 'not_approved' | 'unknown' {
  if (flags === null) return 'unknown';
  const bits = INTENT_FLAGS[intent];
  if ((flags & bits.approved) === bits.approved) return 'approved';
  if ((flags & bits.limited) === bits.limited) return 'limited';
  return 'not_approved';
}

/**
 * Application flags describe Discord-side intent approval/availability. They
 * cannot prove which intents this process requested in its Gateway identify
 * payload. The current Gateway client requests no privileged intents, so the
 * runtime state is deliberately not configured until that becomes explicit.
 */
function runtimeIntentState(_intent: GatewayIntentName): 'enabled' | 'not_configured' | 'unknown' {
  return 'not_configured';
}

function reportTools(options: {
  readonly identityLocked: boolean;
  readonly applicationReady: boolean;
  readonly guildReady: boolean;
  readonly channelReady: boolean;
  readonly permissionEvidenceComplete: boolean;
  readonly effectivePermissions: bigint;
  readonly intentFlags: bigint | null;
  readonly dmConsentMode: Config['MCP_DM_CONSENT_MODE'];
}): ToolAccessReport[] {
  return listKnownToolAccessRequirements().map((entry) => {
    const requirement = entry.requirement;
    if (requirement === null) {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: 'unknown',
        auth: 'unknown',
        required_permissions: [],
        required_intents: [],
        missing_permissions: [],
        missing_intents: [],
        reason: 'No access requirement is catalogued for this tool.',
      };
    }
    if (requirement.auth === 'bearer') {
      return {
        tool_name: entry.toolName,
        status: 'bearer_required',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason: 'The current bot token cannot satisfy this user-OAuth-only operation.',
      };
    }
    if (requirement.auth === 'opaque') {
      return {
        tool_name: entry.toolName,
        status: 'opaque_required',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Discord authorizes this route with a short-lived interaction or webhook token, not bot role permissions.',
      };
    }
    if (requirement.auth === 'none') {
      const targetNeeded = requirement.scope === 'guild' || requirement.scope === 'channel';
      return {
        tool_name: entry.toolName,
        status: targetNeeded && !options.guildReady ? 'unknown' : 'ready',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          targetNeeded && !options.guildReady
            ? 'The public or local operation still needs an explicit target guild before it can be reported ready.'
            : 'This operation is local, public, or uses an external provider; no bot permission is required.',
      };
    }
    if (requirement.verification === 'delegated') {
      return {
        tool_name: entry.toolName,
        status: 'delegated_required',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'This lifecycle route has its own target-bound planner, permission, drift, and readback verifier; this generic report is not execution proof.',
      };
    }
    if (requirement.requireConditionMatch === true) {
      return {
        tool_name: entry.toolName,
        status: 'conditional',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'This tool has field-dependent access; run the report with the exact action payload before applying it.',
      };
    }
    if (
      requirement.scope === 'bot_application' &&
      (!options.identityLocked || !options.applicationReady)
    ) {
      return {
        tool_name: entry.toolName,
        status: 'identity_unlocked',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason: !options.identityLocked
          ? 'Set DISCORD_EXPECTED_BOT_ID or activate a saved profile before bot-scoped writes.'
          : 'The current application identity could not be verified.',
      };
    }
    if (entry.toolName === 'users_create_dm' && options.dmConsentMode === 'require') {
      return {
        tool_name: entry.toolName,
        status: 'consent_required',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Bot identity/access is ready, but a separate recipient-bound caller approval is required before the DM route can execute.',
      };
    }
    if (!options.guildReady && (requirement.scope === 'guild' || requirement.scope === 'channel')) {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason: 'The target guild was not verified.',
      };
    }
    if (requirement.scope === 'channel' && !options.channelReady) {
      return {
        tool_name: entry.toolName,
        status: 'needs_channel',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason: 'Pass --channel-id to evaluate channel overwrites.',
      };
    }
    if (requirement.scope === 'channel' && !options.permissionEvidenceComplete) {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Channel permission overwrites were not complete, so channel access cannot be proven.',
      };
    }
    const missingPermissions = requirement.permissions.filter((name) => {
      // Requirements are kept as a small named registry; unknown names are
      // deliberately treated as missing rather than silently allowed.
      const bit = DISCORD_PERMISSION_BITS[name];
      return bit === undefined || (options.effectivePermissions & bit) !== bit;
    });
    // A missing role makes the observed guild permission union an
    // under-approximation: an unreturned role may still grant a required bit.
    // Do not turn incomplete evidence into a false "denied" conclusion.
    if (
      !options.permissionEvidenceComplete &&
      requirement.scope === 'guild' &&
      missingPermissions.some((name) => DISCORD_PERMISSION_BITS[name] !== undefined)
    ) {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Guild permission evidence was partial; an unreturned role may still grant the required permission.',
      };
    }
    const unknownIntents = requirement.intents.filter(
      (intent) => intentState(options.intentFlags, intent) === 'unknown',
    );
    const missingIntents = requirement.intents.filter(
      (intent) =>
        intentState(options.intentFlags, intent) === 'not_approved' ||
        runtimeIntentState(intent) === 'not_configured',
    );
    if (missingPermissions.length > 0) {
      return {
        tool_name: entry.toolName,
        status: 'missing_permissions',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: missingPermissions,
        missing_intents: missingIntents,
      };
    }
    if (unknownIntents.length > 0) {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Application intent approval flags were unavailable; privileged intent access cannot be concluded.',
      };
    }
    if (missingIntents.length > 0) {
      return {
        tool_name: entry.toolName,
        status: 'missing_intents',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: missingIntents,
        reason:
          'Application approval does not prove that this Gateway runtime requested the privileged intent.',
      };
    }
    if (requirement.hierarchy === 'required') {
      return {
        tool_name: entry.toolName,
        status: 'unknown',
        scope: requirement.scope,
        auth: requirement.auth,
        required_permissions: requirement.permissions,
        required_intents: requirement.intents,
        missing_permissions: [],
        missing_intents: [],
        reason:
          'Role hierarchy requires a concrete target member or role; this report only evaluates the bot.',
      };
    }
    return {
      tool_name: entry.toolName,
      status: 'ready',
      scope: requirement.scope,
      auth: requirement.auth,
      required_permissions: requirement.permissions,
      required_intents: requirement.intents,
      missing_permissions: [],
      missing_intents: [],
    };
  });
}

/**
 * Read-only online preflight for the caller-owned bot and one optional guild.
 * This is intentionally advisory in the first rollout: it produces bounded,
 * machine-readable evidence for `doctor --access` without becoming a second
 * authorization middleware with a risk of false positives.
 */
export async function botAccessPreflightCheck(options: BotAccessOptions): Promise<CheckResult> {
  if (options.config === null) {
    return { id: 'bot-access', status: 'warn', message: 'cannot verify - config invalid' };
  }

  const target = resolveGuildId(options);
  if ('error' in target) {
    return { id: 'bot-access', status: 'fail', message: target.error };
  }

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const warnings: string[] = [];
  const base = baseUrl();
  let user: RawUser;
  let application: RawApplication | null = null;

  try {
    const identityResponse = await fetchJson(
      fetcher,
      base,
      '/users/@me',
      options.config.DISCORD_TOKEN,
      controller.signal,
    );
    if (identityResponse.status !== 200) {
      return {
        id: 'bot-access',
        status: identityResponse.status === 429 ? 'warn' : 'fail',
        message: safeStatusMessage(identityResponse.status, '/users/@me'),
        details: {
          status: identityResponse.status,
          retry_after_seconds: identityResponse.retryAfterSeconds,
        },
      };
    }
    user = parseUser(identityResponse.value);
    if (!user.bot) {
      return {
        id: 'bot-access',
        status: 'fail',
        message: 'The configured credential belongs to a non-bot identity.',
      };
    }
    const expected = options.config.DISCORD_EXPECTED_BOT_ID ?? options.profile?.bot.id;
    const identityLocked = expected !== undefined;
    if (expected !== undefined && user.id !== expected) {
      return {
        id: 'bot-access',
        status: 'fail',
        message: `bot identity mismatch: expected ${expected}, received ${user.id}`,
        details: { expected_bot_id: expected, actual_bot_id: user.id },
      };
    }
    if (!identityLocked)
      warnings.push(
        'DISCORD_EXPECTED_BOT_ID is not configured; bot-scoped writes remain advisory.',
      );

    const applicationResponse = await fetchJson(
      fetcher,
      base,
      '/applications/@me',
      options.config.DISCORD_TOKEN,
      controller.signal,
    );
    if (applicationResponse.status === 200) {
      try {
        application = parseApplication(applicationResponse.value);
        if (application.id !== user.id) {
          return {
            id: 'bot-access',
            status: 'fail',
            message: `application identity mismatch: expected application ${user.id}, received ${application.id}`,
            details: {
              bot_id: user.id,
              application_id: application.id,
              expected_application_id: user.id,
            },
          };
        }
        if (application.botId !== undefined && application.botId !== user.id) {
          return {
            id: 'bot-access',
            status: 'fail',
            message: `application identity mismatch: expected bot ${user.id}, received ${application.botId}`,
            details: {
              bot_id: user.id,
              application_id: application.id,
              application_bot_id: application.botId,
            },
          };
        }
        if (application.botId === undefined)
          warnings.push(
            'The application response did not include its bot identity; app-scoped readiness remains unknown.',
          );
      } catch (error) {
        warnings.push(
          error instanceof Error ? error.message : 'Application response was malformed.',
        );
      }
    } else {
      warnings.push(safeStatusMessage(applicationResponse.status, '/applications/@me'));
    }

    const details: Record<string, unknown> = {
      bot_id: user.id,
      username: user.username ?? null,
      bot: true,
      expected_bot_id: expected ?? null,
      identity_locked: identityLocked,
      identity_match: expected === undefined ? null : user.id === expected,
      application_id: application?.id ?? null,
      application_bot_id: application?.botId ?? null,
      application_identity: application?.botId === user.id ? 'verified' : 'unknown',
      guild_id: 'id' in target ? target.id : null,
      warnings,
      // Preserve the stable public label while keeping delegated and
      // consent-sensitive routes visible in the detailed entries.
      tool_access_scope: 'catalogued_subset',
      tool_access_catalogued_count: listKnownToolAccessRequirements().length,
    };

    if ('warning' in target) {
      warnings.push(target.warning);
      details.warnings = warnings;
      details.tool_access = reportTools({
        identityLocked,
        applicationReady: application?.botId === user.id,
        guildReady: false,
        channelReady: false,
        permissionEvidenceComplete: false,
        effectivePermissions: 0n,
        intentFlags: parseBitfield(application?.flags_new ?? application?.flags),
        dmConsentMode: options.config.MCP_DM_CONSENT_MODE,
      });
      return {
        id: 'bot-access',
        status: 'warn',
        message: target.warning,
        details,
      };
    }

    const guildId = target.id;
    const [guildResponse, memberResponse, rolesResponse] = await Promise.all([
      fetchJson(
        fetcher,
        base,
        `/guilds/${guildId}`,
        options.config.DISCORD_TOKEN,
        controller.signal,
      ),
      fetchJson(
        fetcher,
        base,
        `/guilds/${guildId}/members/${user.id}`,
        options.config.DISCORD_TOKEN,
        controller.signal,
      ),
      fetchJson(
        fetcher,
        base,
        `/guilds/${guildId}/roles`,
        options.config.DISCORD_TOKEN,
        controller.signal,
      ),
    ]);

    if (memberResponse.status !== 200) {
      return {
        id: 'bot-access',
        status: memberResponse.status === 429 ? 'warn' : 'fail',
        message: safeStatusMessage(memberResponse.status, `/guilds/${guildId}/members/${user.id}`),
        details: {
          ...details,
          status: memberResponse.status,
          retry_after_seconds: memberResponse.retryAfterSeconds,
        },
      };
    }
    if (rolesResponse.status !== 200) {
      return {
        id: 'bot-access',
        status: rolesResponse.status === 429 ? 'warn' : 'fail',
        message: safeStatusMessage(rolesResponse.status, `/guilds/${guildId}/roles`),
        details: {
          ...details,
          status: rolesResponse.status,
          retry_after_seconds: rolesResponse.retryAfterSeconds,
        },
      };
    }

    const member = parseMember(memberResponse.value, user.id);
    const roles = parseRoles(rolesResponse.value);
    const guildReady = guildResponse.status === 200;
    const guild = guildReady ? parseGuild(guildResponse.value, guildId) : { id: guildId };
    if (guildResponse.status !== 200)
      warnings.push(safeStatusMessage(guildResponse.status, `/guilds/${guildId}`));

    let channel: ReturnType<typeof parseChannel> | undefined;
    if (options.channelId !== undefined) {
      if (!SNOWFLAKE_RE.test(options.channelId)) {
        return {
          id: 'bot-access',
          status: 'fail',
          message: '--channel-id must be a 17-20 digit Discord snowflake',
        };
      }
      const channelResponse = await fetchJson(
        fetcher,
        base,
        `/channels/${options.channelId}`,
        options.config.DISCORD_TOKEN,
        controller.signal,
      );
      if (channelResponse.status !== 200) {
        return {
          id: 'bot-access',
          status: channelResponse.status === 429 ? 'warn' : 'fail',
          message: safeStatusMessage(channelResponse.status, `/channels/${options.channelId}`),
          details: {
            ...details,
            status: channelResponse.status,
            retry_after_seconds: channelResponse.retryAfterSeconds,
          },
        };
      }
      channel = parseChannel(channelResponse.value, options.channelId, guildId);
    }

    const evaluationOptions = {
      guildId,
      roles,
      member,
      ...(guild.ownerId === undefined ? {} : { guildOwnerId: guild.ownerId }),
      ...(channel === undefined ? {} : { channel }),
    } satisfies Parameters<typeof evaluateBotPermissions>[0];
    const evaluation = evaluateBotPermissions(evaluationOptions);
    const intentFlags = parseBitfield(application?.flags_new ?? application?.flags);
    const toolAccess = reportTools({
      identityLocked,
      applicationReady: application?.botId === user.id,
      guildReady,
      channelReady: channel !== undefined,
      permissionEvidenceComplete: evaluation.confidence === 'complete',
      effectivePermissions: evaluation.effectivePermissions,
      intentFlags,
      dmConsentMode: options.config.MCP_DM_CONSENT_MODE,
    });
    const nonReady = toolAccess.filter((entry) => entry.status !== 'ready');
    if (evaluation.confidence !== 'complete')
      warnings.push('Permission evidence is partial; unknown is not treated as allowed.');
    if (nonReady.length > 0)
      warnings.push(
        `${nonReady.length} catalogued tool requirement(s) are not proven ready for this target.`,
      );

    Object.assign(details, {
      guild_member: true,
      guild_verified: guildReady,
      guild_status: guildResponse.status,
      guild_retry_after_seconds: guildResponse.retryAfterSeconds,
      base_permissions: evaluation.basePermissions.toString(),
      effective_permissions: evaluation.effectivePermissions.toString(),
      unknown_permission_bits: evaluation.unknownPermissionBits.toString(),
      missing_role_ids: evaluation.missingRoleIds,
      top_role_id: evaluation.topRoleId,
      administrator: evaluation.administrator,
      guild_owner: evaluation.guildOwner,
      channel_id: channel?.id ?? null,
      permission_source_channel_id: evaluation.permissionSourceChannelId,
      permission_confidence: evaluation.confidence,
      intents: {
        GUILD_MEMBERS: {
          application: intentState(intentFlags, 'GUILD_MEMBERS'),
          runtime: runtimeIntentState('GUILD_MEMBERS'),
        },
        MESSAGE_CONTENT: {
          application: intentState(intentFlags, 'MESSAGE_CONTENT'),
          runtime: runtimeIntentState('MESSAGE_CONTENT'),
        },
      },
      tool_access: toolAccess,
      warnings,
    });

    return {
      id: 'bot-access',
      status: warnings.length === 0 ? 'ok' : 'warn',
      message:
        warnings.length === 0
          ? `Bot ${user.id} is verified for guild ${guildId}.`
          : guildReady
            ? `Bot identity and guild membership are verified; ${warnings.length} access caveat(s) remain.`
            : `Bot identity is verified, but guild evidence is incomplete; ${warnings.length} access caveat(s) remain.`,
      details,
    };
  } catch (_error) {
    const aborted = controller.signal.aborted;
    return {
      id: 'bot-access',
      status: 'warn',
      message: aborted
        ? 'Bot access preflight timed out; no permission conclusion was made.'
        : 'Bot access preflight could not complete; no permission conclusion was made.',
      details: {
        target_guild_id: 'id' in target ? target.id : null,
        error_type: aborted ? 'timeout' : 'malformed_or_network_response',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
