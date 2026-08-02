import { DiscordAPIError, HTTPError, RateLimitError } from '@discordjs/rest';
import { BrokenCircuitError, BulkheadRejectedError, IsolatedCircuitError } from 'cockatiel';
import { describe, expect, it } from 'vitest';
import { formatErrorForUser } from './format.js';
import {
  CancelledError,
  DiscordAuthError,
  DiscordCloudflareBlocked,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordRateLimitError,
  DryRunPreview,
  GuildNotAllowedError,
  GuildScopeUnresolvedError,
  ScopeRejectedError,
  ValidationError,
} from './index.js';
import { BulkheadFullError, CircuitOpenError, DiscordServerErrorImpl } from './server.js';

const stdio = { toolName: 'messages_send', transport: 'stdio' as const };
const requestBody = { files: undefined, json: undefined } as const;

function apiError(status: number, code = 0, extra: Record<string, unknown> = {}): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: `status ${status}`, ...extra },
    code,
    status,
    'GET',
    'https://discord.com/api/v10/channels/123456789012345678',
    requestBody,
  );
}

describe('formatErrorForUser', () => {
  it('formats DiscordPermissionError with markdown body + structured', () => {
    const r = formatErrorForUser(
      new DiscordPermissionError(['MANAGE_MESSAGES'], ['SEND_MESSAGES'], 'channel:1'),
      stdio,
    );
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Permission Denied/);
    expect(text).toMatch(/MANAGE_MESSAGES/);
    expect(text).toMatch(/SEND_MESSAGES/);
    expect(r.structuredContent).toMatchObject({
      code: 'DISCORD_PERMISSION_DENIED',
      retriable: false,
      category: 'client',
      missing: ['MANAGE_MESSAGES'],
      have: ['SEND_MESSAGES'],
      resource: 'channel:1',
    });
  });

  it('formats DiscordRateLimitError with retry_after_ms in structured', () => {
    const r = formatErrorForUser(
      new DiscordRateLimitError(2400, 'POST /channels/X/messages', 'user', 'messages_bulk_send'),
      stdio,
    );
    expect(r.structuredContent).toMatchObject({
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      retry_after_ms: 2400,
      bucket: 'POST /channels/X/messages',
      scope: 'user',
      suggested_tool: 'messages_bulk_send',
      recovery_hint: expect.any(String),
    });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Rate Limited/);
    expect(text).toMatch(/2400ms/);
    expect(text).toMatch(/messages_bulk_send/);
  });

  it('formats DiscordNotFoundError', () => {
    const r = formatErrorForUser(new DiscordNotFoundError('channel', '99'), stdio);
    expect(r.structuredContent).toMatchObject({
      code: 'DISCORD_NOT_FOUND',
      retriable: false,
      resource_type: 'channel',
      id: '99',
      suggested_tool: 'channels_list',
    });
  });

  it('formats ValidationError with bullet list', () => {
    const r = formatErrorForUser(
      new ValidationError([
        { path: 'channel_id', message: 'Must be 17-20 digit', code: 'invalid_string' },
      ]),
      stdio,
    );
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Input Error/);
    expect(text).toMatch(/channel_id/);
    expect(r.structuredContent).toMatchObject({
      code: 'VALIDATION_FAILED',
      retriable: false,
      recovery_hint: expect.any(String),
    });
  });

  it('formats DiscordCloudflareBlocked with STOP warning', () => {
    const r = formatErrorForUser(new DiscordCloudflareBlocked(), stdio);
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/CLOUDFLARE BANNED/);
    expect(text).toMatch(/STOP/);
    expect(r.structuredContent).toMatchObject({ retry_after_ms: 3_600_000 });
  });

  it('formats ScopeRejectedError', () => {
    const r = formatErrorForUser(
      new ScopeRejectedError('member_ban', 'moderation', ['read', 'write']),
      stdio,
    );
    expect(r.structuredContent).toMatchObject({
      code: 'SCOPE_REJECTED',
      tool: 'member_ban',
      required: 'moderation',
      granted: ['read', 'write'],
    });
  });

  it('formats GuildNotAllowedError', () => {
    const r = formatErrorForUser(new GuildNotAllowedError('1234'), stdio);
    expect(r.structuredContent).toMatchObject({ code: 'GUILD_NOT_ALLOWED', guild_id: '1234' });
  });

  it('formats GuildScopeUnresolvedError', () => {
    const r = formatErrorForUser(
      new GuildScopeUnresolvedError('tool interactions_create_response'),
      stdio,
    );
    expect(r.structuredContent).toMatchObject({
      code: 'GUILD_SCOPE_UNRESOLVED',
      resource: 'tool interactions_create_response',
    });
  });

  it('formats DryRunPreview with embedded JSON preview', () => {
    const r = formatErrorForUser(new DryRunPreview('member_ban', { user_id: '5' }), stdio);
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Dry-Run/);
    expect(text).toMatch(/"user_id"/);
    expect(text).toMatch(/"5"/);
  });

  it('formats CancelledError', () => {
    const r = formatErrorForUser(new CancelledError(), stdio);
    expect(r.structuredContent).toMatchObject({
      code: 'CANCELLED',
      retriable: false,
      recovery_hint: expect.any(String),
    });
  });

  it('formats DiscordServerErrorImpl as server error with sentryEventId', () => {
    const r = formatErrorForUser(new DiscordServerErrorImpl(503, 'POST /x'), {
      ...stdio,
      sentryEventId: 'abc123',
    });
    expect(r.structuredContent).toMatchObject({
      code: 'DISCORD_SERVER_ERROR',
      category: 'server',
      retriable: true,
      trace_id: 'abc123',
    });
  });

  it('formats DiscordAuthError', () => {
    const r = formatErrorForUser(new DiscordAuthError('bad token'), stdio);
    expect(r.structuredContent).toMatchObject({
      code: 'DISCORD_AUTH_INVALID',
      retriable: false,
    });
  });

  it.each([
    [400, 'VALIDATION_FAILED', false, 'client'],
    [401, 'DISCORD_AUTH_INVALID', false, 'client'],
    [403, 'DISCORD_PERMISSION_DENIED', false, 'client'],
    [404, 'DISCORD_NOT_FOUND', false, 'client'],
    [503, 'DISCORD_SERVER_ERROR', true, 'server'],
  ] as const)('maps DiscordAPIError HTTP %i to %s', (status, code, retriable, category) => {
    const result = formatErrorForUser(apiError(status, 50_000 + status), stdio);
    expect(result.structuredContent).toMatchObject({
      code,
      retriable,
      category,
      status,
      discord_code: 50_000 + status,
    });
  });

  it('maps a Discord 429 body without leaking its URL or request body', () => {
    const result = formatErrorForUser(apiError(429, 0, { retry_after: 0.75 }), stdio);
    expect(result.structuredContent).toMatchObject({
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      category: 'client',
      status: 429,
      retry_after_ms: 750,
    });
    expect(JSON.stringify(result)).not.toContain('discord.com/api');
  });

  it('maps HTTPError client and server statuses without treating 4xx as retryable', () => {
    const rejected = formatErrorForUser(
      new HTTPError(418, "I'm a teapot", 'GET', 'https://discord.com/api/v10/test', requestBody),
      stdio,
    );
    expect(rejected.structuredContent).toMatchObject({
      code: 'VALIDATION_FAILED',
      retriable: false,
      category: 'client',
      status: 418,
    });

    const upstream = formatErrorForUser(
      new HTTPError(502, 'Bad Gateway', 'GET', 'https://discord.com/api/v10/test', requestBody),
      stdio,
    );
    expect(upstream.structuredContent).toMatchObject({
      code: 'DISCORD_SERVER_ERROR',
      retriable: true,
      category: 'server',
      status: 502,
    });
  });

  it('maps the REST rate-limit error with its millisecond retry delay', () => {
    const result = formatErrorForUser(
      new RateLimitError({
        timeToReset: 1000,
        limit: 5,
        method: 'POST',
        hash: 'hash',
        url: 'https://discord.com/api/v10/test',
        route: '/test',
        majorParameter: 'global',
        global: false,
        retryAfter: 1500,
        sublimitTimeout: 0,
        scope: 'user',
      }),
      stdio,
    );
    expect(result.structuredContent).toMatchObject({
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      retry_after_ms: 1500,
    });
  });

  it('falls back to INTERNAL_ERROR for unknown thrown values', () => {
    const r = formatErrorForUser('plain string thrown', stdio);
    expect(r.structuredContent).toMatchObject({
      code: 'INTERNAL_ERROR',
      recovery_hint: expect.any(String),
    });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Internal Error/);
    expect(text).toMatch(/messages_send/);
  });

  it('includes sentry event id in trace_id when provided for unknown errors', () => {
    const r = formatErrorForUser(new Error('boom'), { ...stdio, sentryEventId: 'evt_999' });
    expect(r.structuredContent).toMatchObject({ trace_id: 'evt_999' });
  });

  describe('cockatiel resilience errors (Plan 8 D.4)', () => {
    it('formats CircuitOpenError with retry_after_ms + retriable=true', () => {
      const r = formatErrorForUser(new CircuitOpenError(60000), stdio);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        code: 'CIRCUIT_OPEN',
        retriable: true,
        category: 'server',
        retry_after_ms: 60000,
      });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/Circuit Open/);
      expect(text).toMatch(/wait 60000ms/);
    });

    it('formats BulkheadFullError with retriable=true + concurrency hint', () => {
      const r = formatErrorForUser(new BulkheadFullError(), stdio);
      expect(r.structuredContent).toMatchObject({
        code: 'BULKHEAD_FULL',
        retriable: true,
        category: 'server',
      });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/Concurrency Limit Exceeded/);
      expect(text).toMatch(/concurrency limit exceeded; retry shortly/);
    });

    it('maps raw cockatiel BrokenCircuitError → CIRCUIT_OPEN structured shape', () => {
      const r = formatErrorForUser(new BrokenCircuitError('open'), stdio);
      expect(r.structuredContent).toMatchObject({
        code: 'CIRCUIT_OPEN',
        retriable: true,
        category: 'server',
      });
    });

    it('maps raw cockatiel IsolatedCircuitError → CIRCUIT_OPEN structured shape', () => {
      // IsolatedCircuitError extends BrokenCircuitError so the same
      // instanceof branch must match.
      const r = formatErrorForUser(new IsolatedCircuitError(), stdio);
      expect(r.structuredContent).toMatchObject({
        code: 'CIRCUIT_OPEN',
        retriable: true,
        category: 'server',
      });
    });

    it('maps raw cockatiel BulkheadRejectedError → BULKHEAD_FULL structured shape', () => {
      const r = formatErrorForUser(new BulkheadRejectedError(0, 0), stdio);
      expect(r.structuredContent).toMatchObject({
        code: 'BULKHEAD_FULL',
        retriable: true,
        category: 'server',
      });
    });
  });
});
