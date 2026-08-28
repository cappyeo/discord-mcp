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

export class RuntimeAccessDeniedError extends DiscordClientError {
  public readonly code = 'RUNTIME_ACCESS_DENIED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly missingPermissions: readonly string[],
    public readonly missingIntents: readonly string[],
    public readonly hierarchy: 'satisfied' | 'not_satisfied' | 'unknown' = 'satisfied',
  ) {
    super(`Runtime access denied for ${tool}`);
    this.recoveryHint = 'Grant the declared bot permissions/intents, then retry the operation.';
  }
}

export class RuntimeAccessUnknownError extends DiscordClientError {
  public readonly code = 'RUNTIME_ACCESS_UNKNOWN';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(`Runtime access could not be proven for ${tool}: ${reason}`);
    this.recoveryHint =
      'Run a complete bot access preflight for the target, or use MCP_ACCESS_MODE=warn/advisory while evidence is unavailable.';
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

export class DmConsentRequired extends DiscordClientError {
  public readonly code = 'DM_CONSENT_REQUIRED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly recipientId: string,
    public readonly payloadHash: string,
    public readonly approvalId: string,
    public readonly expiresAt: number,
  ) {
    super(`Explicit caller approval required for ${tool}`);
    this.recoveryHint =
      `Have the host/operator review the recipient, then retry with __consent:true, __consent_hash:"${payloadHash}", ` +
      `and __consent_id:"${approvalId}" before ${new Date(expiresAt).toISOString()}`;
  }
}

export class DmConsentRejected extends DiscordClientError {
  public readonly code = 'DM_CONSENT_REJECTED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly reason: 'missing' | 'expired' | 'replayed' | 'mismatch',
  ) {
    super(`DM consent rejected for ${tool}: ${reason}`);
    this.recoveryHint = 'Request a fresh DM consent preview and use its one-time approval ID.';
  }
}

/** Discord may have opened the DM channel even though its response was lost. */
export class DmOutcomeUnknown extends DiscordClientError {
  public readonly code = 'DM_OUTCOME_UNKNOWN';
  public readonly retriable = false;
  public constructor(public readonly recipientId: string) {
    super('The DM channel outcome is unknown because Discord did not return a definitive response');
    this.recoveryHint =
      'Do not retry with the consumed approval. Verify the desired DM state, then request a fresh recipient-bound approval only if it is still needed.';
  }
}

/**
 * A high-risk payload must be reviewed before a write can be executed. The
 * digest binds the approval to the exact validated payload rather than to a
 * reusable boolean confirmation flag.
 */
export class PayloadConfirmationRequired extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_REQUIRED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly payloadHash: string,
    public readonly riskFlags: readonly string[],
    public readonly preview: Record<string, unknown>,
    public readonly approvalId: string,
    public readonly expiresAt: number,
  ) {
    super(`Payload confirmation required for ${tool}`);
    this.recoveryHint =
      `Review the bounded component summary and payload_hash ${payloadHash}, then retry with MCP_DRY_RUN=false, ` +
      `__confirm:true, __confirm_hash:"${payloadHash}", and __confirm_id:"${approvalId}" ` +
      `before ${new Date(expiresAt).toISOString()}`;
  }
}

/** The caller approved a different payload than the one being executed. */
export class PayloadConfirmationMismatch extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_MISMATCH';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly payloadHash: string,
    public readonly receivedHash: string,
    public readonly riskFlags: readonly string[],
    public readonly preview: Record<string, unknown>,
  ) {
    super(`Payload confirmation hash mismatch for ${tool}`);
    this.recoveryHint = `Use the latest payload_hash ${payloadHash}; the supplied __confirm_hash does not match.`;
  }
}

/** An approval token was not issued by this server instance or has expired from its ledger. */
export class PayloadConfirmationApprovalMissing extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_APPROVAL_MISSING';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly approvalId: string,
  ) {
    super(`Payload approval ${approvalId} is not available for ${tool}`);
    this.recoveryHint =
      'The approval may belong to another process or have been evicted; verify the desired Discord state, then request a fresh payload preview if needed.';
  }
}

/** A one-time approval was already consumed before this call. */
export class PayloadConfirmationApprovalReplayed extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_APPROVAL_REPLAYED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly approvalId: string,
  ) {
    super(`Payload approval ${approvalId} was already consumed for ${tool}`);
    this.recoveryHint =
      'First verify whether the earlier attempt reached Discord; only then request a fresh payload preview if the desired state is still absent.';
  }
}

/** A one-time approval expired before it was consumed. */
export class PayloadConfirmationApprovalExpired extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_APPROVAL_EXPIRED';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly approvalId: string,
  ) {
    super(`Payload approval ${approvalId} expired for ${tool}`);
    this.recoveryHint =
      'Request a fresh payload preview and approve it within the displayed expiry window.';
  }
}

/** An approval exists, but its bot, tool, target, or payload binding does not match this call. */
export class PayloadConfirmationApprovalMismatch extends DiscordClientError {
  public readonly code = 'PAYLOAD_CONFIRMATION_APPROVAL_MISMATCH';
  public readonly retriable = false;
  public constructor(
    public readonly tool: string,
    public readonly approvalId: string,
  ) {
    super(`Payload approval ${approvalId} does not match ${tool}`);
    this.recoveryHint =
      'Use the __confirm_id with the exact locked bot, tool, target, and payload from its preview.';
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
