/**
 * Unit tests for `tokenOnlineCheck` — Plan 9 Phase C.
 *
 * We mock global `fetch` via `vi.stubGlobal` per Phase C plan; vitest
 * auto-restores stubbed globals between tests but we still call
 * `vi.unstubAllGlobals()` in afterEach for explicitness (and to be safe
 * against any test running in isolation).
 */
import type { Config } from '@discord-mcp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenOnlineCheck } from './token-online.js';

function makeConfig(token: string): Config {
  // tokenOnlineCheck only reads DISCORD_TOKEN — structural cast keeps the
  // test focused without constructing every Config field.
  return { DISCORD_TOKEN: token } as unknown as Config;
}

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tokenOnlineCheck', () => {
  it('has the correct id, description, and online flag', () => {
    expect(tokenOnlineCheck.id).toBe('token-online');
    expect(tokenOnlineCheck.description).toBe('Discord token verification (live)');
    expect(tokenOnlineCheck.online).toBe(true);
  });

  it('returns warn without making a request when config is null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(null);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('config invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok with bot identity on 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1234', username: 'bot-name', bot: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('ok');
    expect(r.message).toContain('bot-name');
    expect(r.details).toEqual({ username: 'bot-name', id: '1234', bot: true });
  });

  it('uses Authorization: Bot <token> with leading "Bot " stripped+re-added', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1', username: 'x', bot: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Pass a token already prefixed with "Bot " — we should still send
    // exactly one "Bot " prefix in the Authorization header.
    await tokenOnlineCheck.run(makeConfig(`Bot ${'x'.repeat(60)}`));
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    const auth = headers.Authorization ?? '';
    expect(auth).toBe(`Bot ${'x'.repeat(60)}`);
    expect(auth.startsWith('Bot Bot ')).toBe(false);
  });

  it('returns fail on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('401');
    expect(r.details).toEqual({ status: 401 });
  });

  it('returns fail on 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('403');
  });

  it('returns warn on 429 with retry_after_seconds parsed from header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('rate-limited');
    expect(r.details?.retry_after_seconds).toBe(7);
  });

  it('returns warn on 429 with retry_after_seconds=0 when header missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('warn');
    expect(r.details?.retry_after_seconds).toBe(0);
  });

  it('returns warn for other 4xx/5xx (e.g. 500)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('warn');
    expect(r.details?.status).toBe(500);
  });

  it('returns warn on network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('ECONNREFUSED');
    expect(r.message).toContain('offline or unreachable');
  });

  it('returns warn on timeout (AbortError)', async () => {
    // Simulate a fetch that respects AbortSignal and rejects with AbortError
    // when aborted. We don't actually wait the 5s timeout — we trigger abort
    // by returning a never-resolving promise that rejects when signal aborts.
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Use fake timers so setTimeout(5000) fires immediately.
    vi.useFakeTimers();
    const promise = tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    await vi.advanceTimersByTimeAsync(5001);
    const r = await promise;
    vi.useRealTimers();

    expect(r.status).toBe('warn');
    expect(r.message).toContain('offline or unreachable');
  });

  it('NEVER includes the actual token in details or message', async () => {
    const secretToken = `Bot ${'s'.repeat(60)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(secretToken));
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(secretToken);
    expect(dump).not.toContain('s'.repeat(60));
  });

  it('handles 200 with non-JSON body gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await tokenOnlineCheck.run(makeConfig(VALID_TOKEN));
    expect(r.status).toBe('ok');
    expect(r.details?.username).toBe(null);
  });
});
