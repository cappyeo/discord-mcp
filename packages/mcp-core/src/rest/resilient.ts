import type { REST } from '@discordjs/rest';
import { BrokenCircuitError, BulkheadRejectedError, type IPolicy } from 'cockatiel';
import { BulkheadFullError, CircuitOpenError } from '../errors/server.js';
import { classifyDiscordError, DiscordRetryableError } from './errors.js';

/**
 * Function deciding whether a thrown error is retryable.  `opts.method` is the
 * HTTP verb of the originating call so the classifier can refuse to retry
 * ambiguous failures on non-idempotent verbs.  The second parameter is
 * optional, so one-arg classifiers remain assignable.
 */
export type ClassifierFn = (
  err: unknown,
  opts?: { method?: string },
) => DiscordRetryableError | null;

/** Options passed to {@link wrapRestWithResilience}. */
export interface WrapResilienceOptions {
  classifier?: ClassifierFn;
  /**
   * The configured `MCP_CIRCUIT_HALF_OPEN_AFTER_MS` so we can include a
   * `wait Nms` `recoveryHint` on `CircuitOpenError`. Optional — defaults
   * to 60_000 (the same default as the Config field) when omitted.
   */
  circuitHalfOpenAfterMs?: number;
}

/**
 * The five HTTP verbs `@discordjs/rest`'s REST class exposes for typical
 * Discord routes.  We override each one to run through the cockatiel
 * policy.
 */
const VERBS = ['get', 'post', 'patch', 'put', 'delete'] as const;
type Verb = (typeof VERBS)[number];

/**
 * Wrap a `@discordjs/rest` REST instance so every verb call passes through
 * the supplied cockatiel policy.  On a thrown error, the classifier converts
 * retryable conditions into a `DiscordRetryableError` (which the policy's
 * `handleType` matches); non-retryable errors are re-thrown unchanged.
 *
 * Critical preservation rules:
 *  1. The original method is `.bind(rest)`'d before reassignment so internal
 *     `this`-references (rate-limit queue manager, etc) still point at the
 *     same REST instance.
 *  2. The wrapper passes through ALL original arguments verbatim — both the
 *     route string and the optional `RequestData` object.
 *  3. On retry exhaustion, cockatiel re-throws the LAST classified error.
 *     We unwrap it to surface the ORIGINAL error to callers (so the existing
 *     `formatErrorForUser` mapping in errors/format.ts still works).
 */
export function wrapRestWithResilience(
  rest: REST,
  policy: IPolicy,
  classifierOrOpts: ClassifierFn | WrapResilienceOptions = classifyDiscordError,
): REST {
  // Backwards-compatible: third arg can be a bare classifier function (the
  // pre-Plan-8-D shape) or an options object.
  const opts: WrapResilienceOptions =
    typeof classifierOrOpts === 'function' ? { classifier: classifierOrOpts } : classifierOrOpts;
  const classifier = opts.classifier ?? classifyDiscordError;
  const halfOpenAfterMs = opts.circuitHalfOpenAfterMs ?? 60_000;
  type RestRecord = REST & Record<Verb, (...args: unknown[]) => Promise<unknown>>;
  const r = rest as RestRecord;

  for (const verb of VERBS) {
    const original = r[verb].bind(rest) as (...args: unknown[]) => Promise<unknown>;

    const wrapped = (...args: unknown[]): Promise<unknown> => {
      return policy.execute(async () => {
        try {
          return await original(...args);
        } catch (err) {
          const retryable = classifier(err, { method: verb });
          if (retryable !== null) {
            throw retryable;
          }
          throw err;
        }
      }) as Promise<unknown>;
    };

    // Re-assign with the wrapped function. We have to lie to TypeScript
    // because each verb has a different return type (CDN routes), but at
    // runtime they're plain async functions.
    r[verb] = wrapped as RestRecord[Verb];
  }

  // After exhaustion the policy re-throws the LAST error, which is a
  // DiscordRetryableError.  We catch it at the verb wrapper layer above
  // by translating back to its `cause` so the existing error formatter
  // sees the original Discord error.  Do this by wrapping the wrapper:
  for (const verb of VERBS) {
    const wrapped = r[verb] as (...args: unknown[]) => Promise<unknown>;
    r[verb] = (async (...args: unknown[]) => {
      try {
        return await wrapped(...args);
      } catch (err) {
        // Plan 8 D.4: cockatiel circuit/bulkhead errors → user-facing
        // CircuitOpenError / BulkheadFullError. Detect the breaker family
        // FIRST since IsolatedCircuitError extends BrokenCircuitError.
        if (err instanceof BrokenCircuitError) {
          throw new CircuitOpenError(halfOpenAfterMs);
        }
        if (err instanceof BulkheadRejectedError) {
          throw new BulkheadFullError();
        }
        if (err instanceof DiscordRetryableError) {
          throw err.cause ?? err;
        }
        throw err;
      }
    }) as RestRecord[Verb];
  }

  return rest;
}
