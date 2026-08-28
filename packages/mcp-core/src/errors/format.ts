import { DiscordAPIError, HTTPError, RateLimitError } from '@discordjs/rest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { BrokenCircuitError, BulkheadRejectedError, TaskCancelledError } from 'cockatiel';
import { DryRunPreview, WritePreview } from './client.js';
import {
  BotScopeUnresolvedError,
  BulkheadFullError,
  CancelledError,
  CircuitOpenError,
  DiscordAuthError,
  DiscordCloudflareBlocked,
  DiscordError,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordRateLimitError,
  DiscordServerError,
  DmConsentRejected,
  DmConsentRequired,
  DmOutcomeUnknown,
  ExternalServiceError,
  GuildNotAllowedError,
  GuildScopeUnresolvedError,
  PayloadConfirmationApprovalExpired,
  PayloadConfirmationApprovalMismatch,
  PayloadConfirmationApprovalMissing,
  PayloadConfirmationApprovalReplayed,
  PayloadConfirmationMismatch,
  PayloadConfirmationRequired,
  RuntimeAccessDeniedError,
  RuntimeAccessUnknownError,
  ScopeRejectedError,
  ValidationError,
} from './index.js';

export interface FormatErrorContext {
  readonly toolName: string;
  readonly transport: 'stdio' | 'http';
  readonly sentryEventId?: string;
}

interface MakeErrorOpts {
  code: string;
  retriable: boolean;
  category: 'client' | 'server';
  recoveryHint: string;
  retry_after_ms?: number;
  text: string;
  structured: Record<string, unknown>;
}

function makeError(opts: MakeErrorOpts): CallToolResult {
  const structured: Record<string, unknown> = {
    code: opts.code,
    retriable: opts.retriable,
    category: opts.category,
    recovery_hint: opts.recoveryHint,
    ...opts.structured,
  };
  if (opts.retry_after_ms !== undefined) {
    structured.retry_after_ms = opts.retry_after_ms;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: opts.text }],
    structuredContent: structured,
  };
}

function formatDiscordRestError(e: unknown, ctx: FormatErrorContext): CallToolResult | undefined {
  if (e instanceof RateLimitError) {
    return makeError({
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      category: 'client',
      recoveryHint: `wait ${e.retryAfter}ms, then retry`,
      retry_after_ms: e.retryAfter,
      text: `**Rate Limited**\n\nDiscord rejected the request temporarily.\n\n**Recovery**: wait ${e.retryAfter}ms, then retry.`,
      structured: { status: 429 },
    });
  }

  if (!(e instanceof DiscordAPIError) && !(e instanceof HTTPError)) return undefined;

  const status = e.status;
  const structured: Record<string, unknown> = { status };
  if (e instanceof DiscordAPIError && typeof e.code === 'number') {
    structured.discord_code = e.code;
  }

  if (status === 400) {
    return makeError({
      code: 'VALIDATION_FAILED',
      retriable: false,
      category: 'client',
      recoveryHint:
        "compare the arguments with this tool's input contract and Discord-specific constraints",
      text:
        `**Discord Rejected the Input**\n\n` +
        `Discord returned HTTP 400 for \`${ctx.toolName}\`.\n\n` +
        "**Recovery**: compare the arguments with this tool's input contract and Discord-specific constraints.",
      structured,
    });
  }
  if (status === 401) {
    return makeError({
      code: 'DISCORD_AUTH_INVALID',
      retriable: false,
      category: 'client',
      recoveryHint: 'refresh or replace that credential, then restart or retry the client flow',
      text:
        `**Authentication Failed**\n\nDiscord rejected the credential used by \`${ctx.toolName}\`.\n\n` +
        '**Recovery**: refresh or replace that credential, then restart or retry the client flow.',
      structured,
    });
  }
  if (status === 403) {
    return makeError({
      code: 'DISCORD_PERMISSION_DENIED',
      retriable: false,
      category: 'client',
      recoveryHint:
        'verify the caller authorization, guild or channel permissions, and resource scope',
      text:
        `**Permission Denied**\n\nDiscord refused \`${ctx.toolName}\` for the current credential and resource.\n\n` +
        '**Recovery**: verify the caller authorization, guild or channel permissions, and resource scope.',
      structured,
    });
  }
  if (status === 404) {
    return makeError({
      code: 'DISCORD_NOT_FOUND',
      retriable: false,
      category: 'client',
      recoveryHint: 'verify the ID, resource visibility, and credential scope',
      text:
        `**Not Found**\n\nDiscord could not expose the resource requested by \`${ctx.toolName}\`.\n\n` +
        '**Recovery**: verify the ID, resource visibility, and credential scope.',
      structured,
    });
  }
  if (status === 429) {
    const rawRetryAfter =
      e instanceof DiscordAPIError
        ? (e.rawError as { retry_after?: unknown } | undefined)?.retry_after
        : undefined;
    const retryAfterMs =
      typeof rawRetryAfter === 'number' ? Math.max(0, Math.round(rawRetryAfter * 1000)) : undefined;
    return makeError({
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      category: 'client',
      recoveryHint:
        retryAfterMs === undefined ? 'wait, then retry' : `wait ${retryAfterMs}ms, then retry`,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      text:
        '**Rate Limited**\n\nDiscord rejected the request temporarily.\n\n' +
        `**Recovery**: ${retryAfterMs === undefined ? 'wait, then retry' : `wait ${retryAfterMs}ms, then retry`}.`,
      structured,
    });
  }
  if (status >= 500 && status < 600) {
    if (ctx.sentryEventId !== undefined) structured.trace_id = ctx.sentryEventId;
    return makeError({
      code: 'DISCORD_SERVER_ERROR',
      retriable: true,
      category: 'server',
      recoveryHint: 'retry with backoff; check status.discord.com if the failure persists',
      text:
        `**Discord Upstream Error**\n\nDiscord returned HTTP ${status}.\n\n` +
        '**Recovery**: retry with backoff; check status.discord.com if the failure persists.',
      structured,
    });
  }
  if (status >= 400 && status < 500) {
    return makeError({
      code: 'VALIDATION_FAILED',
      retriable: false,
      category: 'client',
      recoveryHint: 'verify the tool arguments and route-specific Discord requirements',
      text:
        `**Discord Rejected the Request**\n\nDiscord returned HTTP ${status} for \`${ctx.toolName}\`.\n\n` +
        '**Recovery**: verify the tool arguments and route-specific Discord requirements.',
      structured,
    });
  }
  return undefined;
}

export function formatErrorForUser(e: unknown, ctx: FormatErrorContext): CallToolResult {
  // Plan 8 D.4: surface cockatiel resilience errors with structured retry hints.
  // CircuitOpenError / BulkheadFullError are the user-facing wrappers raised by
  // wrapRestWithResilience.  We also catch the raw cockatiel exceptions for
  // any code path that might pass them in directly (defensive fallback).
  if (e instanceof CircuitOpenError) {
    return makeError({
      code: e.code,
      retriable: true,
      category: 'server',
      recoveryHint: e.recoveryHint ?? 'wait, then retry',
      retry_after_ms: e.retryAfterMs,
      text:
        `**Upstream Circuit Open**\n\n` +
        `discord-mcp opened the local circuit breaker because Discord REST has been failing repeatedly.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { retry_after_ms: e.retryAfterMs },
    });
  }
  if (e instanceof BulkheadFullError) {
    return makeError({
      code: e.code,
      retriable: true,
      category: 'server',
      recoveryHint: e.recoveryHint ?? 'retry shortly',
      text:
        `**Concurrency Limit Exceeded**\n\n` +
        `Local bulkhead rejected the request - too many concurrent Discord REST calls in flight.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {},
    });
  }
  if (e instanceof BulkheadRejectedError) {
    return makeError({
      code: 'BULKHEAD_FULL',
      retriable: true,
      category: 'server',
      recoveryHint: 'concurrency limit exceeded; retry shortly',
      text:
        `**Concurrency Limit Exceeded**\n\n` +
        `Local bulkhead rejected the request - too many concurrent Discord REST calls in flight.\n\n` +
        `**Recovery**: concurrency limit exceeded; retry shortly`,
      structured: {},
    });
  }
  // BrokenCircuitError covers IsolatedCircuitError (subclass).
  if (e instanceof BrokenCircuitError) {
    return makeError({
      code: 'CIRCUIT_OPEN',
      retriable: true,
      category: 'server',
      recoveryHint: 'wait and retry',
      text:
        `**Upstream Circuit Open**\n\n` +
        `discord-mcp opened the local circuit breaker because Discord REST has been failing repeatedly.\n\n` +
        `**Recovery**: wait and retry`,
      structured: {},
    });
  }

  if (e instanceof TaskCancelledError) {
    const structured: Record<string, unknown> = {};
    if (ctx.sentryEventId !== undefined) structured.trace_id = ctx.sentryEventId;
    return makeError({
      code: 'UPSTREAM_TIMEOUT',
      retriable: true,
      category: 'server',
      recoveryHint: 'retry with backoff',
      text:
        `**Upstream Timeout**\n\n` +
        `The upstream request for \`${ctx.toolName}\` exceeded its timeout.\n\n` +
        '**Recovery**: retry with backoff.',
      structured,
    });
  }

  const discordRestError = formatDiscordRestError(e, ctx);
  if (discordRestError !== undefined) return discordRestError;

  if (e instanceof DiscordPermissionError) {
    const haveStr = e.have.length
      ? e.have.map((p) => `\`${p}\``).join(', ')
      : '_(none on this resource)_';
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'grant the missing permission, then retry',
      text:
        `**Permission Denied** on \`${e.resource}\`\n\n` +
        `**Missing**: ${e.missing.map((p) => `\`${p}\``).join(', ')}\n` +
        `**Bot has**: ${haveStr}\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { missing: [...e.missing], have: [...e.have], resource: e.resource },
    });
  }

  if (e instanceof DiscordRateLimitError) {
    const altLine =
      e.suggestedTool !== undefined
        ? `**Alternative**: use \`${e.suggestedTool}\` to batch.\n`
        : '';
    const structured: Record<string, unknown> = {
      retry_after_ms: e.retryAfterMs,
      bucket: e.bucket,
      scope: e.scope,
    };
    if (e.suggestedTool !== undefined) {
      structured.suggested_tool = e.suggestedTool;
    }
    return makeError({
      code: e.code,
      retriable: true,
      category: 'client',
      recoveryHint:
        e.suggestedTool === undefined
          ? `wait ${e.retryAfterMs}ms, then retry`
          : `wait ${e.retryAfterMs}ms, then retry or use ${e.suggestedTool} to batch`,
      retry_after_ms: e.retryAfterMs,
      text:
        `**Rate Limited**\n\n` +
        `Discord ${e.scope} bucket \`${e.bucket}\` hit. Retry after **${e.retryAfterMs}ms**.\n` +
        altLine,
      structured,
    });
  }

  if (e instanceof DiscordNotFoundError) {
    const suggLine =
      e.suggestedTool !== undefined ? `**List available**: \`${e.suggestedTool}\`` : '';
    const structured: Record<string, unknown> = {
      resource_type: e.resourceType,
      id: e.id,
    };
    if (e.suggestedTool !== undefined) {
      structured.suggested_tool = e.suggestedTool;
    }
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'verify the resource ID and visibility',
      text:
        `**Not Found**: ${e.resourceType} \`${e.id}\` not accessible.\n\n` +
        `**Recovery**: ${e.recoveryHint}\n` +
        suggLine,
      structured,
    });
  }

  if (e instanceof ValidationError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'correct the invalid arguments, then retry',
      text:
        `**Input Error**\n\n` +
        e.issues.map((i) => `- \`${i.path}\`: ${i.message}`).join('\n') +
        `\n\n**Recovery**: ${e.recoveryHint}`,
      structured: { issues: e.issues.map((i) => ({ ...i })) },
    });
  }

  if (e instanceof DiscordCloudflareBlocked) {
    const until = new Date(Date.now() + e.retryAfterMs).toISOString();
    return makeError({
      code: e.code,
      retriable: true,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'stop requests and wait before retrying',
      retry_after_ms: e.retryAfterMs,
      text:
        `**🚨 CLOUDFLARE BANNED**\n\n` +
        `Bot IP banned ~1h for >10K invalid requests in 10min window.\n` +
        `**STOP** all Discord operations until ${until}.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { retry_after_ms: e.retryAfterMs },
    });
  }

  if (e instanceof ScopeRejectedError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'enable the required category, then retry',
      text:
        `**Tool Disabled**: \`${e.tool}\` requires scope \`${e.required}\`.\n` +
        `Currently granted: [${e.granted.join(', ')}].\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { tool: e.tool, required: e.required, granted: [...e.granted] },
    });
  }

  if (e instanceof GuildNotAllowedError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'use an allowed guild',
      text:
        `**Guild Restricted**: \`${e.guildId}\` not in allowlist.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { guild_id: e.guildId },
    });
  }

  if (e instanceof GuildScopeUnresolvedError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'use a resource in an allowed guild',
      text:
        `**Guild Scope Unresolved**: could not prove that \`${e.resource}\` belongs to an allowed guild.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { resource: e.resource },
    });
  }

  if (e instanceof BotScopeUnresolvedError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'use the locked bot application',
      text:
        `**Bot Scope Unresolved**: could not prove that \`${e.resource}\` belongs to the locked bot application.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { resource: e.resource },
    });
  }

  if (e instanceof RuntimeAccessDeniedError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'grant the missing bot access, then retry',
      text:
        `**Runtime Access Denied** for \`${e.tool}\`.\n\n` +
        `Missing permissions: ${e.missingPermissions.join(', ') || 'none'}; ` +
        `missing intents: ${e.missingIntents.join(', ') || 'none'}; ` +
        `role hierarchy: ${e.hierarchy}.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {
        tool: e.tool,
        missing_permissions: [...e.missingPermissions],
        missing_intents: [...e.missingIntents],
        hierarchy: e.hierarchy,
      },
    });
  }

  if (e instanceof RuntimeAccessUnknownError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'complete an access preflight, then retry',
      text:
        `**Runtime Access Unresolved** for \`${e.tool}\`.\n\n` +
        `No complete permission conclusion was available.\n\n**Recovery**: ${e.recoveryHint}`,
      structured: { tool: e.tool, reason: e.reason },
    });
  }

  if (e instanceof PayloadConfirmationRequired) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'review the preview and confirm the exact payload',
      text:
        `**Payload Confirmation Required** for \`${e.tool}\` (no action taken).\n\n` +
        `Review the bounded component summary and retry with the exact \`payload_hash\`; approval binds the payload supplied in the call.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {
        tool: e.tool,
        payload_hash: e.payloadHash,
        risk_flags: [...e.riskFlags],
        approval_id: e.approvalId,
        approval_expires_at: new Date(e.expiresAt).toISOString(),
        preview: e.preview,
      },
    });
  }

  if (e instanceof DmConsentRequired) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'review the recipient and provide explicit caller approval',
      text:
        `**DM Caller Approval Required** for \`${e.tool}\` (no action taken).\n\n` +
        `Have the host/operator review recipient \`${e.recipientId}\`, then retry with the exact consent hash and one-time approval ID.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {
        tool: e.tool,
        recipient_id: e.recipientId,
        consent_hash: e.payloadHash,
        consent_id: e.approvalId,
        consent_expires_at: new Date(e.expiresAt).toISOString(),
      },
    });
  }

  if (e instanceof DmConsentRejected) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'request a fresh DM consent preview after caller review',
      text:
        `**DM Consent Rejected** for \`${e.tool}\` (no action taken).\n\n` +
        `The one-time approval is ${e.reason}.\n\n**Recovery**: ${e.recoveryHint}`,
      structured: { tool: e.tool, reason: e.reason },
    });
  }

  if (e instanceof DmOutcomeUnknown) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'verify the DM state before requesting fresh approval',
      text:
        `**DM Outcome Unknown** for recipient \`${e.recipientId}\`.\n\n` +
        'Discord may have opened the DM channel before the response was lost. Do not retry with the consumed approval.\n\n' +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { recipient_id: e.recipientId, outcome: 'unknown' },
    });
  }

  if (e instanceof PayloadConfirmationMismatch) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'request a fresh preview and confirm its hash',
      text:
        `**Payload Confirmation Mismatch** for \`${e.tool}\` (no action taken).\n\n` +
        `The approved hash does not match the current payload.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {
        tool: e.tool,
        payload_hash: e.payloadHash,
        received_hash: e.receivedHash,
        risk_flags: [...e.riskFlags],
        preview: e.preview,
      },
    });
  }

  if (
    e instanceof PayloadConfirmationApprovalMissing ||
    e instanceof PayloadConfirmationApprovalReplayed ||
    e instanceof PayloadConfirmationApprovalExpired ||
    e instanceof PayloadConfirmationApprovalMismatch
  ) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint:
        e.recoveryHint ?? 'request a fresh payload preview and use its approval ID before expiry',
      text:
        `**Payload Approval Rejected** for \`${e.tool}\` (no action taken).\n\n` +
        `**Recovery**: ${e.recoveryHint ?? 'request a fresh payload preview and use its approval ID before expiry'}`,
      structured: { tool: e.tool, approval_id: e.approvalId },
    });
  }

  if (e instanceof DryRunPreview || e instanceof WritePreview) {
    const label = e instanceof WritePreview ? '**Write Preview**' : '**Dry-Run**';
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint ?? 'review the preview before enabling execution',
      text:
        `${label} (no action taken): would call \`${e.tool}\` with:\n\n` +
        '```json\n' +
        JSON.stringify(e.preview, null, 2) +
        '\n```\n\n' +
        `**Recovery**: ${e.recoveryHint}`,
      structured: { tool: e.tool, preview: e.preview as Record<string, unknown> },
    });
  }

  if (e instanceof CancelledError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint,
      text: `**Cancelled** by client.\n\n${e.recoveryHint ?? ''}`,
      structured: {},
    });
  }

  if (e instanceof DiscordAuthError) {
    return makeError({
      code: e.code,
      retriable: false,
      category: 'client',
      recoveryHint: e.recoveryHint,
      text: `**Authentication Failed**\n\n${e.message}\n\n**Recovery**: ${e.recoveryHint}`,
      structured: {},
    });
  }

  if (e instanceof ExternalServiceError) {
    return makeError({
      code: e.code,
      retriable: true,
      category: 'server',
      recoveryHint: e.recoveryHint ?? 'retry later',
      text:
        `**External Provider Unavailable**\n\n` +
        `${e.provider} could not serve this read-only request.\n\n` +
        `**Recovery**: ${e.recoveryHint}`,
      structured: {
        provider: e.provider,
        ...(e.status === undefined ? {} : { status: e.status }),
      },
    });
  }

  if (e instanceof DiscordServerError) {
    const structured: Record<string, unknown> = {};
    if (ctx.sentryEventId !== undefined) {
      structured.trace_id = ctx.sentryEventId;
    }
    return makeError({
      code: e.code,
      retriable: true,
      category: 'server',
      recoveryHint: e.recoveryHint ?? 'retry',
      text:
        `**Discord Upstream Error**\n\n` +
        `${e.message}\n\n` +
        (ctx.sentryEventId !== undefined ? `Tracked: \`${ctx.sentryEventId}\`.\n\n` : '') +
        `**Recovery**: ${e.recoveryHint ?? 'retry'}`,
      structured,
    });
  }

  if (e instanceof DiscordError) {
    return makeError({
      code: e.code,
      retriable: e.retriable,
      category: e.category,
      recoveryHint: e.recoveryHint ?? 'review the error and correct the request before retrying',
      text:
        `**${e.code}**\n\n${e.message}\n\n` +
        (e.recoveryHint !== undefined ? `**Recovery**: ${e.recoveryHint}` : ''),
      structured: {},
    });
  }

  const structured: Record<string, unknown> = {};
  if (ctx.sentryEventId !== undefined) {
    structured.trace_id = ctx.sentryEventId;
  }
  return makeError({
    code: 'INTERNAL_ERROR',
    retriable: true,
    category: 'server',
    recoveryHint: 'retry in 5s; if persistent, contact the maintainer with the trace ID',
    text:
      `**Internal Error in \`${ctx.toolName}\`**\n\n` +
      `Unexpected upstream issue.${ctx.sentryEventId !== undefined ? ` Tracked: \`${ctx.sentryEventId}\`.` : ''}\n` +
      `**Recovery**: retry in 5s. If persistent, contact maintainer with the trace ID.`,
    structured,
  });
}
