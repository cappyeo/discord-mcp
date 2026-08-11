import type { REST } from '@discordjs/rest';
import { DiscordAPIError } from '@discordjs/rest';
import { handleType, type IPolicy, retry } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import { classifyDiscordError, DiscordRetryableError } from './errors.js';
import { wrapRestWithResilience } from './resilient.js';

const REQ_BODY = { files: undefined, json: undefined } as const;

/** A no-op policy that just runs the function once. */
function noopPolicy(): IPolicy {
  return {
    _altReturn: undefined as never,
    onSuccess: (() => () => undefined) as never,
    onFailure: (() => () => undefined) as never,
    execute: async <T>(fn: (ctx: { signal: AbortSignal }) => Promise<T> | T) => {
      const signal = new AbortController().signal;
      return fn({ signal });
    },
  } as unknown as IPolicy;
}

/** Policy fixture with a deterministic context signal and caller capture. */
function signalPolicy(
  signal: AbortSignal,
  onExecute?: (callerSignal: AbortSignal | undefined) => void,
): IPolicy {
  return {
    _altReturn: undefined as never,
    onSuccess: (() => () => undefined) as never,
    onFailure: (() => () => undefined) as never,
    execute: async <T>(
      fn: (ctx: { signal: AbortSignal }) => Promise<T> | T,
      callerSignal?: AbortSignal,
    ) => {
      onExecute?.(callerSignal);
      return fn({ signal });
    },
  } as unknown as IPolicy;
}

/** A retry policy that retries DiscordRetryableError up to 3 times with no delay. */
function fastRetryPolicy(): IPolicy {
  // Use cockatiel's own retry with a constant zero backoff for fast tests.
  // ConstantBackoff with 0ms is fine.
  // We avoid pulling buildPolicy() here to keep this test focused.
  return retry(handleType(DiscordRetryableError), {
    maxAttempts: 2,
    backoff: { next: () => ({ duration: 0, next: () => ({ duration: 0 }) }) } as never,
  }) as unknown as IPolicy;
}

/** Build a fake REST whose verb methods record args + can be told what to throw. */
function buildFakeRest(handlers: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  const calls: Array<{ verb: string; args: unknown[] }> = [];
  const rest = {
    get: vi.fn(async (...args: unknown[]) => {
      calls.push({ verb: 'get', args });
      return handlers.get ? handlers.get(...args) : { ok: true };
    }),
    post: vi.fn(async (...args: unknown[]) => {
      calls.push({ verb: 'post', args });
      return handlers.post ? handlers.post(...args) : { ok: true };
    }),
    patch: vi.fn(async (...args: unknown[]) => {
      calls.push({ verb: 'patch', args });
      return handlers.patch ? handlers.patch(...args) : { ok: true };
    }),
    put: vi.fn(async (...args: unknown[]) => {
      calls.push({ verb: 'put', args });
      return handlers.put ? handlers.put(...args) : { ok: true };
    }),
    delete: vi.fn(async (...args: unknown[]) => {
      calls.push({ verb: 'delete', args });
      return handlers.delete ? handlers.delete(...args) : { ok: true };
    }),
  } as unknown as REST;
  return { rest, calls };
}

describe('wrapRestWithResilience (Plan 8 C.3)', () => {
  it('proxies all 5 verbs through the policy and returns the original value', async () => {
    const { rest, calls } = buildFakeRest({});
    const policySignal = new AbortController().signal;
    const wrapped = wrapRestWithResilience(rest, signalPolicy(policySignal));

    const r1 = await wrapped.get('/channels/1');
    const r2 = await wrapped.post('/channels/1/messages', { body: { content: 'hi' } });
    const r3 = await wrapped.patch('/channels/1/messages/2', { body: { content: 'edit' } });
    const r4 = await wrapped.put('/channels/1');
    const r5 = await wrapped.delete('/channels/1/messages/2');

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(r3).toEqual({ ok: true });
    expect(r4).toEqual({ ok: true });
    expect(r5).toEqual({ ok: true });
    expect(calls.map((c) => c.verb)).toEqual(['get', 'post', 'patch', 'put', 'delete']);
    expect(
      calls.every((call) => (call.args[1] as { signal?: AbortSignal }).signal === policySignal),
    ).toBe(true);
  });

  it('clones request options while preserving route and caller-owned data', async () => {
    const { rest, calls } = buildFakeRest({});
    const wrapped = wrapRestWithResilience(rest, noopPolicy());

    const requestData = { body: { a: 1 }, files: [], reason: 'r' };
    await wrapped.post('/x', requestData);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.verb).toBe('post');
    expect(calls[0]?.args[0]).toBe('/x');
    expect(calls[0]?.args[1]).toMatchObject({ body: { a: 1 }, files: [], reason: 'r' });
    expect(calls[0]?.args[1]).not.toBe(requestData);
    expect(requestData).toEqual({ body: { a: 1 }, files: [], reason: 'r' });
  });

  it('merges a caller signal with the policy signal without mutating RequestData', async () => {
    const callerController = new AbortController();
    const policyController = new AbortController();
    const callerSignals: Array<AbortSignal | undefined> = [];
    const { rest, calls } = buildFakeRest({});
    const requestData = { body: { content: 'hi' }, signal: callerController.signal };
    const wrapped = wrapRestWithResilience(
      rest,
      signalPolicy(policyController.signal, (callerSignal) => callerSignals.push(callerSignal)),
    );

    await wrapped.post('/x', requestData);

    const forwarded = calls[0]?.args[1] as { body: unknown; signal: AbortSignal };
    expect(callerSignals).toEqual([callerController.signal]);
    expect(forwarded.body).toEqual({ content: 'hi' });
    expect(forwarded.signal).not.toBe(callerController.signal);
    expect(forwarded.signal).not.toBe(policyController.signal);
    expect(forwarded.signal.aborted).toBe(false);
    expect(requestData.signal).toBe(callerController.signal);

    callerController.abort();
    expect(forwarded.signal.aborted).toBe(true);
    expect(requestData.signal.aborted).toBe(true);
    expect(forwarded.signal.reason).toBe(requestData.signal.reason);
  });

  it('does not let a policy cancellation complete an in-flight REST operation late', async () => {
    const policyController = new AbortController();
    let completed = false;
    let aborted = false;
    const { rest } = buildFakeRest({
      get: (_route, options) =>
        new Promise((_resolve, reject) => {
          const requestSignal = (options as { signal?: AbortSignal }).signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            aborted = true;
            if (timer !== undefined) clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (requestSignal?.aborted) {
            onAbort();
            return;
          }
          requestSignal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => {
            completed = true;
            _resolve({ ok: true });
          }, 50);
        }),
    });
    const wrapped = wrapRestWithResilience(rest, signalPolicy(policyController.signal));

    const request = wrapped.get('/x');
    await Promise.resolve();
    policyController.abort();

    await expect(request).rejects.toBeInstanceOf(DOMException);
    expect(aborted).toBe(true);
    expect(completed).toBe(false);
  });

  it('does not let a caller abort complete an in-flight REST operation late', async () => {
    const callerController = new AbortController();
    let completed = false;
    let aborted = false;
    const { rest } = buildFakeRest({
      get: (_route, options) =>
        new Promise((_resolve, reject) => {
          const requestSignal = (options as { signal?: AbortSignal }).signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            aborted = true;
            if (timer !== undefined) clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (requestSignal?.aborted) {
            onAbort();
            return;
          }
          requestSignal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => {
            completed = true;
            _resolve({ ok: true });
          }, 50);
        }),
    });
    const wrapped = wrapRestWithResilience(rest, noopPolicy());

    const request = wrapped.get('/x', { signal: callerController.signal });
    await Promise.resolve();
    callerController.abort();

    await expect(request).rejects.toBeInstanceOf(DOMException);
    expect(aborted).toBe(true);
    expect(completed).toBe(false);
  });

  it('retries 5xx and eventually succeeds (returns the recovered value)', async () => {
    let count = 0;
    const apiErr500 = new DiscordAPIError(
      { code: 0, message: 'upstream' },
      0,
      500,
      'GET',
      'https://discord.com/api/v10/x',
      REQ_BODY,
    );
    // GET, not POST: 5xx on a POST is ambiguous (the write may have landed)
    // and is deliberately non-retryable - see classifyDiscordError.
    const { rest } = buildFakeRest({
      get: () => {
        count++;
        if (count < 2) throw apiErr500;
        return { id: 'ok' };
      },
    });
    const wrapped = wrapRestWithResilience(rest, fastRetryPolicy());

    const result = await wrapped.get('/channels/1');
    expect(result).toEqual({ id: 'ok' });
    expect(count).toBe(2);
  });

  it('non-retryable error (400) is NOT retried - original error bubbles', async () => {
    const apiErr400 = new DiscordAPIError(
      { code: 50035, message: 'Invalid form body' },
      50035,
      400,
      'POST',
      'https://discord.com/api/v10/x',
      REQ_BODY,
    );
    let count = 0;
    const { rest } = buildFakeRest({
      post: () => {
        count++;
        throw apiErr400;
      },
    });
    const wrapped = wrapRestWithResilience(rest, fastRetryPolicy());

    await expect(wrapped.post('/x', { body: {} })).rejects.toBe(apiErr400);
    expect(count).toBe(1);
  });

  it('on retry exhaustion, surfaces the ORIGINAL error (cause), not DiscordRetryableError', async () => {
    const apiErr500 = new DiscordAPIError(
      { code: 0, message: 'forever broken' },
      0,
      503,
      'GET',
      'https://discord.com/api/v10/x',
      REQ_BODY,
    );
    const { rest } = buildFakeRest({
      get: () => {
        throw apiErr500;
      },
    });
    const wrapped = wrapRestWithResilience(rest, fastRetryPolicy());

    await expect(wrapped.get('/x')).rejects.toBe(apiErr500);
  });

  it('classifier hook can be replaced (e.g. retry every error)', async () => {
    let count = 0;
    const plainErr = new Error('weird');
    const { rest } = buildFakeRest({
      get: () => {
        count++;
        if (count < 2) throw plainErr;
        return { ok: true };
      },
    });
    const wrapped = wrapRestWithResilience(
      rest,
      fastRetryPolicy(),
      // Custom classifier marks every Error retryable.
      (err) => (err instanceof Error ? new DiscordRetryableError(err, null) : null),
    );

    const result = await wrapped.get('/x');
    expect(result).toEqual({ ok: true });
    expect(count).toBe(2);
  });

  it('default classifier is classifyDiscordError (sanity: 4xx not retried)', async () => {
    let count = 0;
    const apiErr401 = new DiscordAPIError(
      { code: 0, message: 'unauthorized' },
      0,
      401,
      'GET',
      'https://discord.com/api/v10/x',
      REQ_BODY,
    );
    expect(classifyDiscordError(apiErr401)).toBeNull();
    const { rest } = buildFakeRest({
      get: () => {
        count++;
        throw apiErr401;
      },
    });
    const wrapped = wrapRestWithResilience(rest, fastRetryPolicy());
    await expect(wrapped.get('/x')).rejects.toBe(apiErr401);
    expect(count).toBe(1);
  });
});
