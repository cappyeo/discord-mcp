import { DiscordAPIError, HTTPError, RateLimitError } from '@discordjs/rest';
import { describe, expect, it } from 'vitest';
import { classifyDiscordError, DiscordRetryableError } from './errors.js';

const REQ_BODY = { files: undefined, json: undefined } as const;

function makeApiError(status: number, code = 0): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: `status ${status}` },
    code,
    status,
    'GET',
    'https://discord.com/api/v10/test',
    REQ_BODY,
  );
}

describe('classifyDiscordError (Plan 8 C.2)', () => {
  it('classifies RateLimitError with retryAfter (ms)', () => {
    const err = new RateLimitError({
      timeToReset: 1000,
      limit: 5,
      method: 'POST',
      hash: 'h',
      url: 'https://discord.com/api/v10/test',
      route: '/test',
      majorParameter: 'global',
      global: false,
      retryAfter: 1500,
      sublimitTimeout: 0,
      scope: 'user',
    });
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.retryAfterMs).toBe(1500);
    expect(result?.cause).toBe(err);
  });

  it('classifies a Discord 429 (DiscordAPIError with rawError.retry_after seconds)', () => {
    // Discord JSON 429 body has retry_after in seconds - we convert to ms.
    const err = new DiscordAPIError(
      { code: 0, message: 'rate-limit', retry_after: 0.75 } as unknown as {
        code: number;
        message: string;
      },
      0,
      429,
      'POST',
      'https://discord.com/api/v10/test',
      REQ_BODY,
    );
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.retryAfterMs).toBe(750);
  });

  it('classifies a 429 with no retry_after as retryable with null delay', () => {
    const err = makeApiError(429);
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.retryAfterMs).toBeNull();
  });

  it('classifies DiscordAPIError 500 as retryable (no retry-after)', () => {
    const err = makeApiError(500);
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.retryAfterMs).toBeNull();
    expect(result?.cause).toBe(err);
  });

  it('classifies DiscordAPIError 503 as retryable', () => {
    const err = makeApiError(503);
    expect(classifyDiscordError(err)).toBeInstanceOf(DiscordRetryableError);
  });

  it('returns null for DiscordAPIError 400 (validation)', () => {
    const err = makeApiError(400);
    expect(classifyDiscordError(err)).toBeNull();
  });

  it('returns null for DiscordAPIError 401 (auth)', () => {
    expect(classifyDiscordError(makeApiError(401))).toBeNull();
  });

  it('returns null for DiscordAPIError 403 (permission)', () => {
    expect(classifyDiscordError(makeApiError(403))).toBeNull();
  });

  it('returns null for DiscordAPIError 404 (not found)', () => {
    expect(classifyDiscordError(makeApiError(404))).toBeNull();
  });

  it('classifies HTTPError 502 as retryable', () => {
    const err = new HTTPError(
      502,
      'Bad Gateway',
      'GET',
      'https://discord.com/api/v10/test',
      REQ_BODY,
    );
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.cause).toBe(err);
  });

  it('returns null for HTTPError 418 (non-server)', () => {
    const err = new HTTPError(418, "I'm a teapot", 'GET', 'https://x', REQ_BODY);
    expect(classifyDiscordError(err)).toBeNull();
  });

  it('classifies ECONNRESET as retryable', () => {
    const err = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const result = classifyDiscordError(err);
    expect(result).toBeInstanceOf(DiscordRetryableError);
    expect(result?.retryAfterMs).toBeNull();
  });

  it('classifies ETIMEDOUT, ENETUNREACH, ENOTFOUND as retryable', () => {
    for (const code of ['ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND'] as const) {
      const err = Object.assign(new Error('net'), { code });
      expect(classifyDiscordError(err)).toBeInstanceOf(DiscordRetryableError);
    }
  });

  it('classifies undici-wrapped network errors via cause chain', () => {
    const inner = Object.assign(new Error('socket'), { code: 'ECONNRESET' });
    const outer = new Error('fetch failed', { cause: inner });
    const result = classifyDiscordError(outer);
    expect(result).toBeInstanceOf(DiscordRetryableError);
  });

  it('returns null for an unknown / non-network plain Error', () => {
    expect(classifyDiscordError(new Error('something else'))).toBeNull();
  });

  it('returns null for non-Error values', () => {
    expect(classifyDiscordError('a string')).toBeNull();
    expect(classifyDiscordError(undefined)).toBeNull();
    expect(classifyDiscordError(null)).toBeNull();
  });
});
