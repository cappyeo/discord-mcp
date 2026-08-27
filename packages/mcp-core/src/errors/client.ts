import { DiscordClientError } from './base.js';

export class DiscordPermissionError extends DiscordClientError {
  public readonly code = 'DISCORD_PERMISSION_DENIED';
  public readonly retriable = false;
  public constructor(
    public readonly missing: readonly string[],
    public readonly have: readonly string[],
    public readonly resource: string,
  ) {
    super(`Missing permissions: ${missing.join(', ')} on ${resource}`);
    const first = missing[0] ?? 'permission';
    this.recoveryHint = `Grant ${first} to bot's role in Server Settings → Roles.`;
  }
}

export class DiscordRateLimitError extends DiscordClientError {
  public readonly code = 'DISCORD_RATE_LIMITED';
  public readonly retriable = true;
  public constructor(
    public readonly retryAfterMs: number,
    public readonly bucket: string,
    public readonly scope: 'user' | 'shared' | 'global',
    batchAlternative?: string,
  ) {
    super(`Rate limited on ${bucket} (${scope}). Retry in ${retryAfterMs}ms.`);
    this.recoveryHint = `Wait ${retryAfterMs}ms then retry`;
    if (batchAlternative !== undefined) {
      this.suggestedTool = batchAlternative;
      this.recoveryHint += ` OR batch via ${batchAlternative}`;
    }
  }
}

export class DiscordNotFoundError extends DiscordClientError {
  public readonly code = 'DISCORD_NOT_FOUND';
  public readonly retriable = false;
  public constructor(
    public readonly resourceType: string,
    public readonly id: string,
  ) {
    super(`${resourceType} ${id} not found`);
    this.recoveryHint = `Verify: 1) ${resourceType} exists 2) bot has VIEW permission 3) ID is correct`;
    this.suggestedTool = `${resourceType.toLowerCase()}s_list`;
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export class ValidationError extends DiscordClientError {
  public readonly code = 'VALIDATION_FAILED';
  public readonly retriable = false;
  public constructor(public readonly issues: readonly ValidationIssue[]) {
    super('Input validation failed');
    const first = issues[0];
    this.recoveryHint = first ? `Fix \`${first.path}\`: ${first.message}` : 'Check input schema';
  }
}

export class DiscordAuthError extends DiscordClientError {
  public readonly code = 'DISCORD_AUTH_INVALID';
  public readonly retriable = false;
  public override recoveryHint =
    'Bot token invalid or revoked. Set DISCORD_TOKEN env to a fresh token.';
}

export class DiscordCloudflareBlocked extends DiscordClientError {
  public readonly code = 'DISCORD_CLOUDFLARE_BLOCKED';
  public readonly retriable = true;
  public constructor(public readonly retryAfterMs: number = 3_600_000) {
    super('Cloudflare 1015 - exceeded 10K invalid requests / 10 min');
    this.recoveryHint = `IP-banned for ~1h. STOP all Discord requests. Investigate which tool spammed invalid args.`;
  }
}

export class ScopeRejectedError extends DiscordClientError {
  public readonly code = 'SCOPE_REJECTED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly required: string,
    public readonly granted: readonly string[],
  ) {
    super(`Tool ${tool} requires scope '${required}', granted: [${granted.join(', ')}]`);
    this.recoveryHint = `Re-launch server with MCP_CATEGORIES including '${required}'`;
  }
}

export class GuildNotAllowedError extends DiscordClientError {
  public readonly code = 'GUILD_NOT_ALLOWED';
  public readonly retriable = false;
  public constructor(public readonly guildId: string) {
    super(`Guild ${guildId} not in ALLOWED_GUILDS`);
    this.recoveryHint = `Add guild ${guildId} to ALLOWED_GUILDS env, OR call from an allowed guild`;
  }
}

export class GuildScopeUnresolvedError extends DiscordClientError {
  public readonly code = 'GUILD_SCOPE_UNRESOLVED';
  public readonly retriable = false;
  public constructor(public readonly resource: string) {
    super(`Cannot prove that ${resource} belongs to an allowed guild`);
    this.recoveryHint =
      'Use a guild-scoped tool or resource whose guild can be verified, or unset ALLOWED_GUILDS';
  }
}

/**
 * A bot-scoped operation could not be tied to the identity locked by the
 * deployment. This is distinct from a guild-scope failure because application
 * emojis are global to the bot application rather than to one guild.
 */
export class BotScopeUnresolvedError extends DiscordClientError {
  public readonly code = 'BOT_SCOPE_UNRESOLVED';
  public readonly retriable = false;
  public constructor(public readonly resource: string) {
    super(`Cannot prove that ${resource} belongs to the locked bot application`);
    this.recoveryHint =
      'Set DISCORD_EXPECTED_BOT_ID and omit application_id, or use the locked bot application ID';
  }
}

export class DryRunPreview extends DiscordClientError {
  public readonly code: string = 'DRY_RUN_PREVIEW';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly preview: unknown,
  ) {
    super(`Dry-run: would call ${tool} with the given args`);
    this.recoveryHint = 'Set MCP_DRY_RUN=false AND pass __confirm:true to actually execute';
  }
}

/**
 * Preview emitted by the opt-in all-write safety policy. Unlike
 * MCP_DRY_RUN, this blocks every mutating tool, not only destructive ones.
 */
export class WritePreview extends DryRunPreview {
  public override readonly code = 'WRITE_PREVIEW';
  public constructor(tool: string, preview: unknown) {
    super(tool, preview);
    this.recoveryHint =
      'Set MCP_WRITE_MODE=allow to execute this mutation; destructive tools still require MCP_DRY_RUN=false and __confirm:true';
  }
}

export class CancelledError extends DiscordClientError {
  public readonly code = 'CANCELLED';
  public readonly retriable = false;
  public override recoveryHint = 'Tool execution cancelled by client';
  public constructor(message = 'Tool execution cancelled by client') {
    super(message);
  }
}
