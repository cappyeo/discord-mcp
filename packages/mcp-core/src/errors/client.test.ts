import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  DiscordAuthError,
  DiscordCloudflareBlocked,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordRateLimitError,
  DryRunPreview,
  GuildNotAllowedError,
  ScopeRejectedError,
  ValidationError,
} from './client.js';

describe('DiscordPermissionError', () => {
  it('captures missing + have permissions and resource', () => {
    const e = new DiscordPermissionError(
      ['MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY'],
      ['SEND_MESSAGES'],
      'channel:1234',
    );
    expect(e.code).toBe('DISCORD_PERMISSION_DENIED');
    expect(e.retriable).toBe(false);
    expect(e.missing).toEqual(['MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY']);
    expect(e.have).toEqual(['SEND_MESSAGES']);
    expect(e.resource).toBe('channel:1234');
    expect(e.recoveryHint).toContain('MANAGE_MESSAGES');
  });
});

describe('DiscordRateLimitError', () => {
  it('captures retry-after, bucket, scope; sets recoveryHint', () => {
    const e = new DiscordRateLimitError(2400, 'POST /channels/X/messages', 'user');
    expect(e.code).toBe('DISCORD_RATE_LIMITED');
    expect(e.retriable).toBe(true);
    expect(e.retryAfterMs).toBe(2400);
    expect(e.bucket).toBe('POST /channels/X/messages');
    expect(e.scope).toBe('user');
    expect(e.recoveryHint).toContain('2400ms');
  });

  it('appends suggested_tool to recoveryHint when provided', () => {
    const e = new DiscordRateLimitError(500, 'b', 'shared', 'messages_bulk_send');
    expect(e.suggestedTool).toBe('messages_bulk_send');
    expect(e.recoveryHint).toContain('messages_bulk_send');
  });
});

describe('DiscordNotFoundError', () => {
  it('captures resourceType + id and suggests a list tool', () => {
    const e = new DiscordNotFoundError('channel', '1234');
    expect(e.code).toBe('DISCORD_NOT_FOUND');
    expect(e.retriable).toBe(false);
    expect(e.resourceType).toBe('channel');
    expect(e.id).toBe('1234');
    expect(e.suggestedTool).toBe('channels_list');
    expect(e.recoveryHint).toContain('VIEW');
  });
});

describe('ValidationError', () => {
  it('captures zod-shape issues and surfaces first issue in recoveryHint', () => {
    const e = new ValidationError([
      {
        path: 'channel_id',
        message: 'Must be a 17-20 digit Discord snowflake',
        code: 'invalid_string',
      },
      {
        path: 'content',
        message: 'String must contain at least 1 character(s)',
        code: 'too_small',
      },
    ]);
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.retriable).toBe(false);
    expect(e.issues).toHaveLength(2);
    expect(e.recoveryHint).toContain('channel_id');
    expect(e.recoveryHint).toContain('17-20 digit');
  });

  it('survives empty issues array with a generic hint', () => {
    const e = new ValidationError([]);
    expect(e.recoveryHint).toContain('Check input schema');
  });
});

describe('DiscordAuthError', () => {
  it('hard-codes recoveryHint pointing to env DISCORD_TOKEN', () => {
    const e = new DiscordAuthError('token rejected by /users/@me');
    expect(e.code).toBe('DISCORD_AUTH_INVALID');
    expect(e.retriable).toBe(false);
    expect(e.recoveryHint).toMatch(/DISCORD_TOKEN/);
  });
});

describe('DiscordCloudflareBlocked', () => {
  it('defaults retryAfterMs to 1 hour and warns to STOP all requests', () => {
    const e = new DiscordCloudflareBlocked();
    expect(e.code).toBe('DISCORD_CLOUDFLARE_BLOCKED');
    expect(e.retriable).toBe(true);
    expect(e.retryAfterMs).toBe(3_600_000);
    expect(e.recoveryHint).toMatch(/IP-banned/);
  });

  it('accepts custom retryAfterMs', () => {
    const e = new DiscordCloudflareBlocked(60_000);
    expect(e.retryAfterMs).toBe(60_000);
  });
});

describe('ScopeRejectedError', () => {
  it('reports tool, required scope, and granted set', () => {
    const e = new ScopeRejectedError('member_ban', 'moderation', ['read', 'write']);
    expect(e.code).toBe('SCOPE_REJECTED');
    expect(e.retriable).toBe(false);
    expect(e.tool).toBe('member_ban');
    expect(e.required).toBe('moderation');
    expect(e.granted).toEqual(['read', 'write']);
    expect(e.recoveryHint).toContain("'moderation'");
  });
});

describe('GuildNotAllowedError', () => {
  it('captures guildId and points to ALLOWED_GUILDS env', () => {
    const e = new GuildNotAllowedError('1234');
    expect(e.code).toBe('GUILD_NOT_ALLOWED');
    expect(e.retriable).toBe(false);
    expect(e.guildId).toBe('1234');
    expect(e.recoveryHint).toContain('ALLOWED_GUILDS');
  });
});

describe('DryRunPreview', () => {
  it('captures tool name and preview args', () => {
    const e = new DryRunPreview('member_ban', { user_id: '5678' });
    expect(e.code).toBe('DRY_RUN_PREVIEW');
    expect(e.retriable).toBe(false);
    expect(e.tool).toBe('member_ban');
    expect(e.preview).toEqual({ user_id: '5678' });
    expect(e.recoveryHint).toMatch(/MCP_DRY_RUN=false/);
    expect(e.recoveryHint).toMatch(/__confirm/);
    // No server-side elicitation exists; the hint must not advertise one.
    expect(e.recoveryHint).not.toMatch(/elicit/i);
  });
});

describe('CancelledError', () => {
  it('is not retriable and explains client cancelled', () => {
    const e = new CancelledError();
    expect(e.code).toBe('CANCELLED');
    expect(e.retriable).toBe(false);
    expect(e.recoveryHint).toContain('cancelled');
  });
});
