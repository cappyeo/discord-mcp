import { type Counter, metrics } from '@opentelemetry/api';
import {
  bulkhead,
  ConsecutiveBreaker,
  circuitBreaker,
  DelegateBackoff,
  decorrelatedJitterGenerator,
  ExponentialBackoff,
  fullJitterGenerator,
  handleType,
  handleWhen,
  type IBackoff,
  type IPolicy,
  type IRetryBackoffContext,
  noJitterGenerator,
  retry,
  TimeoutStrategy,
  timeout,
  wrap,
} from 'cockatiel';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import {
  ATTR_CIRCUIT_TO_STATE,
  ATTR_ERROR_TYPE,
  METRIC_BULKHEAD_REJECTED,
  METRIC_CIRCUIT_TRANSITIONS,
  METRIC_DEADLETTER,
  TELEMETRY_INSTRUMENTATION_NAME,
  TELEMETRY_INSTRUMENTATION_VERSION,
} from '../telemetry/conventions.js';
import { DiscordRetryableError } from './errors.js';

/**
 * Build the composite resilience policy for Discord REST calls.
 *
 * Layout (outer → inner) when all features enabled:
 *   bulkhead(MCP_BULKHEAD_LIMIT, queueSize=0)              ← fast-reject when over limit
 *     └─ circuitBreaker(handleAll.orType(DiscordRetryableError),
 *                       ConsecutiveBreaker(MCP_CIRCUIT_FAILURE_THRESHOLD),
 *                       halfOpenAfter=MCP_CIRCUIT_HALF_OPEN_AFTER_MS)
 *          └─ retry(handleType(DiscordRetryableError))    ← MCP_RETRY_ENABLED
 *               └─ timeout(MCP_TIMEOUT_DEFAULT_MS, Aggressive)
 *
 * Composition rationale (Plan 8 §13 risk register):
 *   - Bulkhead is OUTERMOST so retries don't slip through bulkhead's accounting
 *     (one in-flight slot per logical user request, not per attempt).
 *   - Breaker is OUTSIDE retry so it sees aggregate behavior across retries.
 *     Each retry-exhausted call counts as ONE consecutive failure to the
 *     breaker, not N. Otherwise threshold semantics are misleading.
 *   - The breaker error filter mirrors the retry filter
 *     (`DiscordRetryableError`) so 4xx never increments the breaker counter
 *     — only true upstream/network failures do.
 *   - `queueSize: 0` on the bulkhead — DO NOT queue. Head-of-line blocking is
 *     worse than fast failure for an agent. The agent can re-issue.
 *
 * Pipeline self-deadlock note (Plan 8 §13):
 *   A pipeline runs N steps SEQUENTIALLY within a single MCP call. The
 *   bulkhead default of 100 leaves ample headroom. Operators who tighten
 *   `MCP_BULKHEAD_LIMIT` should keep ≥ 10 to avoid head-of-line stalls when
 *   pipelines fan out.
 *
 * Telemetry hooks (Plan 8 D.1 + D.3 + D.5):
 *   - breaker.onBreak / onHalfOpen / onReset
 *       → log + emit `mcp.circuit.transitions{to_state}` counter.
 *   - bulkhead.onReject
 *       → log + emit `mcp.bulkhead.rejected.count` counter.
 *   - <final policy>.onFailure
 *       → log dead-letter + emit `mcp.deadletter.count{error.type}` counter.
 *
 * Disabled paths:
 *   - `!MCP_RETRY_ENABLED`: skip retry, use `wrap(bulkhead?, breaker?, timeout)`.
 *   - `!MCP_CIRCUIT_ENABLED`: skip breaker. Hooks for breaker are also skipped.
 *   - Bulkhead is always present (cockatiel doesn't expose an off-switch and
 *     the limit defaults to 100 — effectively unbounded for stdio agents).
 *
 * @param config Loaded config — only the resilience fields are read.
 * @param logger Optional pino logger for hook observability. When omitted
 *               (test paths), hooks still emit OTel metrics.
 */
export function buildPolicy(config: Config, logger?: Logger): IPolicy {
  const timeoutPolicy = timeout(config.MCP_TIMEOUT_DEFAULT_MS, TimeoutStrategy.Aggressive);

  // Pre-build an exponential backoff FACTORY using the configured jitter
  // strategy.  `ExponentialBackoff` is an `IBackoffFactory`: its `next()`
  // always returns a FIRST-attempt `IBackoff`.  The growing chain lives on
  // the returned instance, so we thread that instance through the
  // `DelegateBackoff` state channel below.
  const exponential = (() => {
    if (config.MCP_RETRY_JITTER === 'decorrelated') {
      return new ExponentialBackoff({
        initialDelay: config.MCP_RETRY_BASE_DELAY_MS,
        maxDelay: config.MCP_RETRY_MAX_DELAY_MS,
        exponent: 2,
        generator: decorrelatedJitterGenerator,
      });
    }
    return new ExponentialBackoff<number>({
      initialDelay: config.MCP_RETRY_BASE_DELAY_MS,
      maxDelay: config.MCP_RETRY_MAX_DELAY_MS,
      exponent: 2,
      generator: config.MCP_RETRY_JITTER === 'none' ? noJitterGenerator : fullJitterGenerator,
    });
  })();

  // Custom backoff: prefer Retry-After when known, otherwise delegate to
  // exponential.  The exponential instance is advanced (and returned as
  // `state`) on EVERY attempt — including the Retry-After branch — so a 429
  // followed by a 5xx does not reset the chain back to the initial delay.
  const customBackoff = new DelegateBackoff<IRetryBackoffContext<unknown>, IBackoff<unknown>>(
    (ctx, state) => {
      const next = state ? state.next(ctx) : exponential.next();
      const err = 'error' in ctx.result ? ctx.result.error : undefined;
      if (err instanceof DiscordRetryableError && err.retryAfterMs !== null) {
        return { delay: err.retryAfterMs, state: next };
      }
      return { delay: next.duration, state: next };
    },
  );

  // `replaySafe` — not just the type — because an ambiguous POST failure is a
  // genuine upstream failure (the breaker below must count it) that must never
  // be re-sent: the write may already have landed at Discord and only the
  // response was lost.
  const retryPolicy = retry(
    handleWhen((e) => e instanceof DiscordRetryableError && e.replaySafe),
    {
      maxAttempts: config.MCP_RETRY_MAX_ATTEMPTS,
      backoff: customBackoff,
    },
  );

  // --- Telemetry: shared meter + counters (Plan 8 D.1 / D.3 / D.5) ---
  // OTel falls back to a no-op meter when no SDK is registered, so this is
  // safe even when OTEL_ENABLED=false.
  const meter = metrics.getMeter(TELEMETRY_INSTRUMENTATION_NAME, TELEMETRY_INSTRUMENTATION_VERSION);
  const circuitTransitions: Counter = meter.createCounter(METRIC_CIRCUIT_TRANSITIONS, {
    description: 'Circuit-breaker state transitions (open / half-open / closed)',
  });
  const bulkheadRejected: Counter = meter.createCounter(METRIC_BULKHEAD_REJECTED, {
    description: 'Bulkhead fast-reject count (over MCP_BULKHEAD_LIMIT)',
  });
  const deadletterCount: Counter = meter.createCounter(METRIC_DEADLETTER, {
    description: 'Terminal failures after retries exhausted, labelled by error.type',
  });

  // --- Circuit breaker (Plan 8 D.1) ---
  // Built only when MCP_CIRCUIT_ENABLED. The breaker matches the TYPE, while
  // retry additionally requires `replaySafe`. That gap is deliberate: an
  // ambiguous POST failure must count toward opening the circuit without ever
  // being re-sent. Non-retryable 4xx is not wrapped at all, so it still
  // bubbles through WITHOUT incrementing the consecutive-failure counter. This matches Plan 8 §13: "Non-retryable Discord errors (4xx)
  // bubble through breaker WITHOUT incrementing failure count."
  // (Spec called for `handleAll.orType(DiscordRetryableError)` but that
  // would treat every error as a circuit failure — including validation
  // 4xx — which is misleading.)
  const breaker = config.MCP_CIRCUIT_ENABLED
    ? circuitBreaker(handleType(DiscordRetryableError), {
        halfOpenAfter: config.MCP_CIRCUIT_HALF_OPEN_AFTER_MS,
        breaker: new ConsecutiveBreaker(config.MCP_CIRCUIT_FAILURE_THRESHOLD),
      })
    : null;

  if (breaker !== null) {
    breaker.onBreak((reason) => {
      try {
        const err =
          'error' in reason
            ? reason.error
            : 'isolated' in reason
              ? new Error('isolated')
              : undefined;
        logger?.warn(
          { event: 'circuit_breaker_open', err: err?.message },
          'circuit breaker opened',
        );
        circuitTransitions.add(1, { [ATTR_CIRCUIT_TO_STATE]: 'open' });
      } catch {
        // Hooks must never throw out of cockatiel — swallow + continue.
      }
    });
    breaker.onHalfOpen(() => {
      try {
        logger?.info({ event: 'circuit_breaker_half_open' }, 'circuit breaker half-open (probing)');
        circuitTransitions.add(1, { [ATTR_CIRCUIT_TO_STATE]: 'half-open' });
      } catch {
        // ignore
      }
    });
    breaker.onReset(() => {
      try {
        logger?.info({ event: 'circuit_breaker_reset' }, 'circuit breaker reset to closed');
        circuitTransitions.add(1, { [ATTR_CIRCUIT_TO_STATE]: 'closed' });
      } catch {
        // ignore
      }
    });
  }

  // --- Bulkhead (Plan 8 D.2) ---
  // Always installed.  queueSize is hard-coded to 0 (fast-reject).
  const concurrencyLimit = bulkhead(config.MCP_BULKHEAD_LIMIT, /* queueSize */ 0);
  concurrencyLimit.onReject(() => {
    try {
      logger?.warn(
        { event: 'bulkhead_rejected', limit: config.MCP_BULKHEAD_LIMIT },
        'bulkhead capacity exceeded',
      );
      bulkheadRejected.add(1);
    } catch {
      // ignore
    }
  });

  // --- Compose ---
  // wrap(outer, …, inner). bulkhead OUTERMOST, then breaker, then retry, then timeout.
  type WrapInputs = Parameters<typeof wrap>;
  const layers: WrapInputs = [concurrencyLimit];
  if (breaker !== null) {
    layers.push(breaker as unknown as WrapInputs[number]);
  }
  if (config.MCP_RETRY_ENABLED) {
    layers.push(retryPolicy as unknown as WrapInputs[number]);
  }
  layers.push(timeoutPolicy as unknown as WrapInputs[number]);

  // Cast: cockatiel's `wrap` overloads cover up to 5 explicit args; we use
  // the variadic form which is typed as `IPolicy<C, A>` — fine for our use.
  const inner = (wrap as (...p: WrapInputs) => IPolicy)(...layers);

  // --- Dead-letter telemetry (Plan 8 D.5) ---
  // The composed `wrap()` policy's `onFailure` mirrors the OUTERMOST layer's
  // event emitter (cockatiel implementation detail). Bulkhead never fires
  // its executor's onFailure, so we cannot rely on `inner.onFailure` for
  // dead-letter accounting. Instead we wrap `execute()` itself: any thrown
  // error that escapes the entire policy chain IS a terminal failure by
  // definition (retries exhausted, breaker opened, bulkhead rejected, etc.).
  // Transient failures handled internally by retry never bubble out, so they
  // do not fire this hook — matching Plan 8 §9 D.5 semantics.
  const final: IPolicy = {
    _altReturn: undefined as never,
    onSuccess: inner.onSuccess,
    onFailure: inner.onFailure,
    async execute(fn, signal) {
      try {
        return await inner.execute(fn, signal);
      } catch (err) {
        try {
          const errorType = err?.constructor.name ?? typeof err;
          const errMessage = err instanceof Error ? err.message : String(err);
          logger?.error(
            {
              event: 'dead_letter',
              tag: 'dead-letter',
              err: errMessage,
              error_type: errorType,
            },
            'request reached dead-letter (retries exhausted or unrecoverable)',
          );
          deadletterCount.add(1, { [ATTR_ERROR_TYPE]: errorType });
        } catch {
          // Telemetry must never crash the policy.  Continue throwing the
          // original error.
        }
        throw err;
      }
    },
  };

  return final;
}
