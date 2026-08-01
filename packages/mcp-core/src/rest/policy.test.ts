import { DiscordAPIError, HTTPError } from '@discordjs/rest';
import { BrokenCircuitError, BulkheadRejectedError, TaskCancelledError } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import { DiscordRetryableError } from './errors.js';
import { buildPolicy } from './policy.js';

const REQ_BODY = { files: undefined, json: undefined } as const;

/** Minimal in-test `Config` shaped object - only the fields buildPolicy reads. */
function cfg(partial: Partial<Config> = {}): Config {
  return {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'info',
    GATEWAY: false,
    OTEL_ENABLED: false,
    OTEL_SERVICE_NAME: 'discord-mcp',
    OTEL_SERVICE_VERSION: '0.8.0',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_HEADERS: undefined,
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
    OTEL_TRACES_SAMPLER_ARG: 1,
    OTEL_CONSOLE_EXPORTER: false,
    MCP_RETRY_ENABLED: true,
    MCP_RETRY_MAX_ATTEMPTS: 3,
    MCP_RETRY_BASE_DELAY_MS: 50,
    MCP_RETRY_MAX_DELAY_MS: 500,
    MCP_RETRY_JITTER: 'none',
    MCP_TIMEOUT_DEFAULT_MS: 5000,
    MCP_CIRCUIT_ENABLED: false,
    MCP_CIRCUIT_FAILURE_THRESHOLD: 10,
    MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 60000,
    MCP_BULKHEAD_LIMIT: 100,
    ...partial,
  } as Config;
}

describe('buildPolicy (Plan 8 C.1)', () => {
  it('retries DiscordRetryableError up to maxAttempts then bubbles last error', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 3, MCP_RETRY_BASE_DELAY_MS: 50 }));

    let attempts = 0;
    const finalErr = new DiscordRetryableError(new Error('5xx upstream'), null);
    await expect(
      policy.execute(async () => {
        attempts++;
        throw finalErr;
      }),
    ).rejects.toBe(finalErr);
    // cockatiel's maxAttempts is the number of *retries*; total tries = maxAttempts + 1.
    expect(attempts).toBe(4);
  });

  it('succeeds on retry after a transient DiscordRetryableError', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 3, MCP_RETRY_BASE_DELAY_MS: 50 }));

    let attempts = 0;
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new DiscordRetryableError(new Error('transient'), null);
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('honors retryAfterMs from Discord 429 (delay >= configured retry-after)', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 2, MCP_RETRY_BASE_DELAY_MS: 50 }));

    let attempts = 0;
    const start = Date.now();
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts === 1) {
        // Force a Retry-After of 250ms; with no jitter the next delay must
        // be at least that.
        throw new DiscordRetryableError(new Error('429'), 250);
      }
      return 'ok';
    });
    const elapsed = Date.now() - start;
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    // Allow 50ms slack for scheduler.
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it('does NOT retry non-DiscordRetryableError (raw 4xx) - bubbles immediately', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 5 }));

    let attempts = 0;
    const err400 = new DiscordAPIError(
      { code: 50035, message: 'Invalid form body' },
      50035,
      400,
      'POST',
      'https://discord.com/api/v10/test',
      REQ_BODY,
    );
    await expect(
      policy.execute(async () => {
        attempts++;
        throw err400;
      }),
    ).rejects.toBe(err400);
    expect(attempts).toBe(1);
  });

  it('does NOT retry HTTPError 418 - non-retryable bubbles', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_MAX_ATTEMPTS: 5 }));

    let attempts = 0;
    const err = new HTTPError(418, 'tea', 'GET', 'https://x', REQ_BODY);
    await expect(
      policy.execute(async () => {
        attempts++;
        throw err;
      }),
    ).rejects.toBe(err);
    expect(attempts).toBe(1);
  });

  it('timeout fires when inner fn exceeds MCP_TIMEOUT_DEFAULT_MS (TaskCancelledError)', async () => {
    const policy = buildPolicy(cfg({ MCP_TIMEOUT_DEFAULT_MS: 1000, MCP_RETRY_ENABLED: false }));
    await expect(
      policy.execute(async () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000))),
    ).rejects.toBeInstanceOf(TaskCancelledError);
  });

  it('returns bare timeout policy when MCP_RETRY_ENABLED=false (no retry)', async () => {
    const policy = buildPolicy(cfg({ MCP_RETRY_ENABLED: false }));
    let attempts = 0;
    const finalErr = new DiscordRetryableError(new Error('5xx'), null);
    await expect(
      policy.execute(async () => {
        attempts++;
        throw finalErr;
      }),
    ).rejects.toBe(finalErr);
    expect(attempts).toBe(1); // no retry
  });

  it('uses jitter generator for non-Retry-After backoff (smoke: completes in bounded time)', async () => {
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_MAX_ATTEMPTS: 2,
        MCP_RETRY_BASE_DELAY_MS: 50,
        MCP_RETRY_MAX_DELAY_MS: 500,
        MCP_RETRY_JITTER: 'full',
      }),
    );
    let attempts = 0;
    const start = Date.now();
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new DiscordRetryableError(new Error('5xx'), null);
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    // A single full-jitter backoff off a 50ms base draws from [0, 50) - the
    // whole run must finish well inside 200ms (100ms+ of scheduler slack).
    expect(Date.now() - start).toBeLessThan(200);
  });

  /**
   * Record the delays the retry policy ASKS for, rather than the gaps we
   * observe. Measuring wall-clock gaps makes the assertion load-sensitive:
   * under parallel CPU pressure a 50ms sleep can be observed as 90ms, which
   * is exactly the flakiness this suite exists to catch elsewhere. The
   * requested delay is the property under test and is deterministic.
   */
  async function recordRetryDelays(config: Config): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (typeof ms === 'number' && ms > 0) delays.push(ms);
      // Collapse the wait so the test does not actually sleep, but keep the
      // async boundary the policy depends on.
      return (realSetTimeout as typeof setTimeout)(fn, 0, ...(rest as []));
    }) as typeof setTimeout);
    try {
      await expect(
        buildPolicy(config).execute(async () => {
          throw new DiscordRetryableError(new Error('5xx'), null);
        }),
      ).rejects.toBeInstanceOf(DiscordRetryableError);
    } finally {
      spy.mockRestore();
    }
    // buildPolicy also wraps a timeout policy, which arms its own timer per
    // attempt at MCP_TIMEOUT_DEFAULT_MS. Drop those; what is under test is the
    // retry backoff chain.
    return delays.filter((d) => d !== config.MCP_TIMEOUT_DEFAULT_MS);
  }

  it('grows the backoff geometrically across retries', async () => {
    // The bug: `exponential` is an IBackoffFactory, so calling .next() fresh
    // each attempt always returned an attempt-0 instance and the delay never
    // grew - every retry waited the base delay and MCP_RETRY_MAX_DELAY_MS was
    // inert. A flat chain yields [50, 50, 50].
    const delays = await recordRetryDelays(
      cfg({
        MCP_RETRY_MAX_ATTEMPTS: 3,
        MCP_RETRY_BASE_DELAY_MS: 50,
        MCP_RETRY_MAX_DELAY_MS: 10000,
        MCP_RETRY_JITTER: 'none',
      }),
    );
    expect(delays).toEqual([50, 100, 200]);
  });

  it('clamps the grown backoff at MCP_RETRY_MAX_DELAY_MS', async () => {
    // Uncapped the third delay would be 200 * 2**2 = 800ms.
    const delays = await recordRetryDelays(
      cfg({
        MCP_RETRY_MAX_ATTEMPTS: 3,
        MCP_RETRY_BASE_DELAY_MS: 200,
        MCP_RETRY_MAX_DELAY_MS: 500,
        MCP_RETRY_JITTER: 'none',
      }),
    );
    expect(delays).toEqual([200, 400, 500]);
  });
});

describe('buildPolicy: circuit breaker (Plan 8 D.1)', () => {
  // Tests use MCP_RETRY_ENABLED=false so each .execute() call hits the
  // breaker exactly once - making consecutive-failure counting predictable.
  const circuitOnly = (partial: Partial<Config> = {}): Config =>
    cfg({
      MCP_RETRY_ENABLED: false,
      MCP_CIRCUIT_ENABLED: true,
      MCP_CIRCUIT_FAILURE_THRESHOLD: 3,
      MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 5000,
      MCP_TIMEOUT_DEFAULT_MS: 5000,
      ...partial,
    });

  it('opens after MCP_CIRCUIT_FAILURE_THRESHOLD consecutive DiscordRetryableErrors', async () => {
    const policy = buildPolicy(circuitOnly());
    const err = new DiscordRetryableError(new Error('5xx'), null);

    // 3 failures → at the 3rd, the breaker opens. The 4th call should
    // reject with BrokenCircuitError without invoking the inner fn.
    let invocations = 0;
    for (let i = 0; i < 3; i++) {
      await expect(
        policy.execute(async () => {
          invocations++;
          throw err;
        }),
      ).rejects.toBe(err);
    }
    expect(invocations).toBe(3);

    let probedAfterOpen = false;
    await expect(
      policy.execute(async () => {
        probedAfterOpen = true;
        return 'unreachable';
      }),
    ).rejects.toBeInstanceOf(BrokenCircuitError);
    expect(probedAfterOpen).toBe(false);
  });

  it('does NOT increment failure counter for non-DiscordRetryableError (4xx bubbles through)', async () => {
    const policy = buildPolicy(circuitOnly({ MCP_CIRCUIT_FAILURE_THRESHOLD: 3 }));
    const err400 = new DiscordAPIError(
      { code: 50035, message: 'Invalid form body' },
      50035,
      400,
      'POST',
      'https://discord.com/api/v10/test',
      REQ_BODY,
    );

    // 5 attempts of a non-retryable 400 - far beyond the threshold of 3.
    // Since the breaker filter is handleType(DiscordRetryableError), 400
    // bubbles through without being counted.
    for (let i = 0; i < 5; i++) {
      await expect(
        policy.execute(async () => {
          throw err400;
        }),
      ).rejects.toBe(err400);
    }

    // The breaker is still closed: a subsequent retryable error should
    // run the inner fn (the circuit isn't open).
    let invoked = false;
    await expect(
      policy.execute(async () => {
        invoked = true;
        throw new DiscordRetryableError(new Error('5xx'), null);
      }),
    ).rejects.toBeInstanceOf(DiscordRetryableError);
    expect(invoked).toBe(true);
  });

  it('after halfOpenAfter, allows ONE probe; success resets to closed', async () => {
    const policy = buildPolicy(
      circuitOnly({
        MCP_CIRCUIT_FAILURE_THRESHOLD: 2,
        MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 5000,
      }),
    );
    const err = new DiscordRetryableError(new Error('5xx'), null);

    // Open the breaker.
    for (let i = 0; i < 2; i++) {
      await expect(
        policy.execute(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }
    // Now confirm open.
    await expect(policy.execute(async () => 'noop')).rejects.toBeInstanceOf(BrokenCircuitError);

    // Advance past halfOpenAfter window with fake timers.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5001);
      // Run a successful probe; the breaker should allow it through and reset.
      const result = await policy.execute(async () => 'recovered');
      expect(result).toBe('recovered');
    } finally {
      vi.useRealTimers();
    }

    // Verify circuit is now closed by running another success.
    const r2 = await policy.execute(async () => 'still-closed');
    expect(r2).toBe('still-closed');
  });

  it('half-open failure re-opens the circuit', async () => {
    const policy = buildPolicy(
      circuitOnly({
        MCP_CIRCUIT_FAILURE_THRESHOLD: 2,
        MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 5000,
      }),
    );
    const err = new DiscordRetryableError(new Error('5xx'), null);

    for (let i = 0; i < 2; i++) {
      await expect(
        policy.execute(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }
    // Confirm open.
    await expect(policy.execute(async () => 'noop')).rejects.toBeInstanceOf(BrokenCircuitError);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5001);
      // Probe fails → breaker opens again.
      await expect(
        policy.execute(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    } finally {
      vi.useRealTimers();
    }

    // Subsequent call should fast-reject (open).
    let probed = false;
    await expect(
      policy.execute(async () => {
        probed = true;
        return 'noop';
      }),
    ).rejects.toBeInstanceOf(BrokenCircuitError);
    expect(probed).toBe(false);
  });

  it('breaker is skipped entirely when MCP_CIRCUIT_ENABLED=false', async () => {
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: false,
        MCP_CIRCUIT_ENABLED: false,
        MCP_CIRCUIT_FAILURE_THRESHOLD: 3,
      }),
    );
    const err = new DiscordRetryableError(new Error('5xx'), null);
    // Even after many consecutive failures, no circuit-open occurs:
    let attempts = 0;
    for (let i = 0; i < 10; i++) {
      attempts++;
      await expect(
        policy.execute(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }
    expect(attempts).toBe(10);
  });
});

describe('buildPolicy: bulkhead (Plan 8 D.2)', () => {
  it('rejects with BulkheadRejectedError when over MCP_BULKHEAD_LIMIT in flight', async () => {
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: false,
        MCP_CIRCUIT_ENABLED: false,
        MCP_BULKHEAD_LIMIT: 2,
      }),
    );

    // Hold two slots open with promises that don't resolve until we say.
    let resolveA: ((v: string) => void) | undefined;
    let resolveB: ((v: string) => void) | undefined;
    const p1 = policy.execute<string>(
      () =>
        new Promise<string>((res) => {
          resolveA = res;
        }),
    );
    const p2 = policy.execute<string>(
      () =>
        new Promise<string>((res) => {
          resolveB = res;
        }),
    );

    // Allow microtasks so cockatiel's bulkhead actually claims the slots.
    await Promise.resolve();
    await Promise.resolve();

    // Third call should be fast-rejected (queueSize=0).
    let invokedThird = false;
    await expect(
      policy.execute(async () => {
        invokedThird = true;
        return 'late';
      }),
    ).rejects.toBeInstanceOf(BulkheadRejectedError);
    expect(invokedThird).toBe(false);

    // Drain the held promises so vitest doesn't hang.
    resolveA?.('a');
    resolveB?.('b');
    await expect(p1).resolves.toBe('a');
    await expect(p2).resolves.toBe('b');
  });
});

describe('buildPolicy: hooks (Plan 8 D.1 + D.3 + D.5)', () => {
  it('breaker.onBreak / onHalfOpen / onReset all fire across the lifecycle', async () => {
    // Inject a logger spy via the optional logger arg so we can also
    // assert the log lines fire (best-effort: logger may be omitted in
    // unit tests but here we verify it works when supplied).
    const fakeLogger = {
      level: 'debug' as const,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      bindings: vi.fn(),
      flush: vi.fn(),
      isLevelEnabled: vi.fn(() => true),
      onChild: vi.fn(),
      silent: vi.fn(),
      version: '0.0.0',
      levels: { values: {}, labels: {} } as never,
      levelVal: 30,
      useLevelLabels: false,
      customLevels: {} as never,
      useOnlyCustomLevels: false,
    };
    type LoggerStub = Parameters<typeof buildPolicy>[1];
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: false,
        MCP_CIRCUIT_ENABLED: true,
        MCP_CIRCUIT_FAILURE_THRESHOLD: 2,
        MCP_CIRCUIT_HALF_OPEN_AFTER_MS: 5000,
      }),
      fakeLogger as unknown as LoggerStub,
    );

    const err = new DiscordRetryableError(new Error('5xx'), null);

    // Trigger break.
    for (let i = 0; i < 2; i++) {
      await expect(
        policy.execute(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }

    expect(
      (fakeLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
        JSON.stringify(c).includes('circuit breaker opened'),
      ),
    ).toBe(true);

    // Move past halfOpenAfter, send a probe success.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5001);
      await policy.execute(async () => 'ok');
    } finally {
      vi.useRealTimers();
    }
    // Both onHalfOpen and onReset should have fired (cockatiel emits
    // half-open BEFORE running the probe, then onReset on success).
    const infoCalls = (fakeLogger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(infoCalls.some((c) => JSON.stringify(c).includes('half-open'))).toBe(true);
    expect(infoCalls.some((c) => JSON.stringify(c).includes('reset to closed'))).toBe(true);
  });

  it('bulkhead.onReject hook fires when over limit', async () => {
    const fakeLogger = {
      level: 'debug' as const,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      bindings: vi.fn(),
      flush: vi.fn(),
      isLevelEnabled: vi.fn(() => true),
      onChild: vi.fn(),
      silent: vi.fn(),
      version: '0.0.0',
      levels: { values: {}, labels: {} } as never,
      levelVal: 30,
      useLevelLabels: false,
      customLevels: {} as never,
      useOnlyCustomLevels: false,
    };
    type LoggerStub = Parameters<typeof buildPolicy>[1];
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: false,
        MCP_CIRCUIT_ENABLED: false,
        MCP_BULKHEAD_LIMIT: 1,
      }),
      fakeLogger as unknown as LoggerStub,
    );

    let release: ((v: string) => void) | undefined;
    const p1 = policy.execute<string>(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );
    await Promise.resolve();

    // Second call rejected.
    await expect(policy.execute(async () => 'late')).rejects.toBeInstanceOf(BulkheadRejectedError);

    expect(
      (fakeLogger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
        JSON.stringify(c).includes('bulkhead capacity exceeded'),
      ),
    ).toBe(true);

    release?.('done');
    await expect(p1).resolves.toBe('done');
  });

  it('final.onFailure (dead-letter) fires after retries exhausted', async () => {
    const fakeLogger = {
      level: 'debug' as const,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      bindings: vi.fn(),
      flush: vi.fn(),
      isLevelEnabled: vi.fn(() => true),
      onChild: vi.fn(),
      silent: vi.fn(),
      version: '0.0.0',
      levels: { values: {}, labels: {} } as never,
      levelVal: 30,
      useLevelLabels: false,
      customLevels: {} as never,
      useOnlyCustomLevels: false,
    };
    type LoggerStub = Parameters<typeof buildPolicy>[1];
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: true,
        MCP_RETRY_MAX_ATTEMPTS: 2,
        MCP_RETRY_BASE_DELAY_MS: 50,
        MCP_CIRCUIT_ENABLED: false,
      }),
      fakeLogger as unknown as LoggerStub,
    );

    const err = new DiscordRetryableError(new Error('terminal'), null);
    await expect(
      policy.execute(async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    // Dead-letter should have logged once (one terminal failure).
    const errorCalls = (fakeLogger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      errorCalls.some(
        (c) =>
          JSON.stringify(c).includes('dead-letter') || JSON.stringify(c).includes('dead_letter'),
      ),
    ).toBe(true);
  });

  it('final.onFailure does NOT fire on transient failures recovered by retry', async () => {
    const fakeLogger = {
      level: 'debug' as const,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      bindings: vi.fn(),
      flush: vi.fn(),
      isLevelEnabled: vi.fn(() => true),
      onChild: vi.fn(),
      silent: vi.fn(),
      version: '0.0.0',
      levels: { values: {}, labels: {} } as never,
      levelVal: 30,
      useLevelLabels: false,
      customLevels: {} as never,
      useOnlyCustomLevels: false,
    };
    type LoggerStub = Parameters<typeof buildPolicy>[1];
    const policy = buildPolicy(
      cfg({
        MCP_RETRY_ENABLED: true,
        MCP_RETRY_MAX_ATTEMPTS: 3,
        MCP_RETRY_BASE_DELAY_MS: 20,
        MCP_CIRCUIT_ENABLED: false,
      }),
      fakeLogger as unknown as LoggerStub,
    );

    let attempts = 0;
    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new DiscordRetryableError(new Error('transient'), null);
      }
      return 'ok';
    });
    expect(result).toBe('ok');

    const errorCalls = (fakeLogger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(errorCalls.some((c) => JSON.stringify(c).includes('dead'))).toBe(false);
  });
});
