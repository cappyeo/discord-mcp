import { DiscordAPIError, HTTPError, RateLimitError } from '@discordjs/rest';

/**
 * Marker error wrapping any retryable upstream condition (5xx, 429,
 * specific network-level resets) so cockatiel can match it via
 * `handleType(DiscordRetryableError)` / `orType` in the composite
 * policy.  See `policy.ts`.
 *
 * Holds:
 *  - `cause`: the original thrown error from `@discordjs/rest`.  Re-thrown
 *    by the resilient adapter once retries are exhausted.
 *  - `retryAfterMs`: when the upstream signaled a specific wait (e.g. a
 *    Discord 429 with `Retry-After`), in milliseconds.  `null` for 5xx
 *    and network errors where we fall back to exponential backoff.
 *  - `replaySafe`: whether the call may actually be re-sent.  Separating this
 *    from "is an upstream failure" matters: an ambiguous POST failure (5xx or
 *    a post-send network reset) must NOT be replayed — the write may already
 *    have landed — but it is still an upstream failure and must feed the
 *    circuit breaker.  Classifying it as non-retryable by returning `null`
 *    instead would leave a POST-heavy workload hammering a fully-down Discord
 *    forever, because the breaker only counts `DiscordRetryableError`.
 */
export class DiscordRetryableError extends Error {
  public override readonly cause: unknown;
  public readonly retryAfterMs: number | null;
  public readonly replaySafe: boolean;

  public constructor(cause: unknown, retryAfterMs: number | null, replaySafe = true) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Retryable upstream error: ${causeMsg}`);
    this.name = 'DiscordRetryableError';
    this.cause = cause;
    this.retryAfterMs = retryAfterMs;
    this.replaySafe = replaySafe;
  }
}

/** Network-level error codes we treat as retryable. */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
]);

/**
 * Network codes that fire AFTER the request may already have reached Discord —
 * the response, not the request, is what was lost.  Replaying these on a
 * non-idempotent verb duplicates the side effect (double message, double ban,
 * double webhook execution).  The remaining codes (`ECONNREFUSED`,
 * `ENOTFOUND`, `EAI_AGAIN`) fail before a single byte is sent, so they stay
 * retryable for every verb.
 */
const AMBIGUOUS_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH']);

/**
 * Inspect an arbitrary thrown value and decide whether it represents a
 * retryable upstream condition.  Returns a `DiscordRetryableError` (so
 * cockatiel matches via `orType`) or `null` for non-retryable errors
 * (4xx other than 429, validation errors, etc).
 *
 * Handles three classes:
 *  1. `RateLimitError` (Discord 429, surfaced by `@discordjs/rest` when
 *     `rejectOnRateLimit` matches the route — currently unused in our
 *     setup, but supported for completeness).
 *  2. `DiscordAPIError` with `status >= 500`. 4xx (auth, permission,
 *     not-found, validation) is non-retryable and falls through.
 *  3. `HTTPError` (low-level fetch failure with a status, e.g. transparent
 *     proxy 502s) when status is 5xx.
 *  4. Plain `Error` whose `code` matches a known retryable network code.
 *
 * `opts.method` is the HTTP verb the call was made with.  For `post` the
 * AMBIGUOUS classes — 5xx and the post-send network codes — are reported as
 * non-retryable, because a POST whose response was lost may already have
 * created the resource.  429 and the pre-send network codes are explicit
 * rejections with no duplicate risk and stay retryable for POST too.
 */
export function classifyDiscordError(
  err: unknown,
  opts?: { method?: string },
): DiscordRetryableError | null {
  const isPost = opts?.method === 'post';

  // --- 429: rate limit ---
  if (err instanceof RateLimitError) {
    // RateLimitError.retryAfter is in milliseconds per @discordjs/rest 2.x docs.
    return new DiscordRetryableError(err, err.retryAfter);
  }

  // --- DiscordAPIError: only 5xx are retryable ---
  if (err instanceof DiscordAPIError) {
    if (err.status >= 500 && err.status < 600) {
      // POST: surface it (the breaker must count it) but mark it un-replayable.
      return new DiscordRetryableError(err, null, !isPost);
    }
    // Some Discord 4xx responses include a 429 status — handle defensively.
    if (err.status === 429) {
      // The body may carry retry_after seconds; convert to ms.
      const raw = (err.rawError as { retry_after?: number } | undefined)?.retry_after;
      const retryAfterMs = typeof raw === 'number' ? Math.round(raw * 1000) : null;
      return new DiscordRetryableError(err, retryAfterMs);
    }
    return null;
  }

  // --- HTTPError: low-level fetch / proxy failure ---
  if (err instanceof HTTPError) {
    if (err.status >= 500 && err.status < 600) {
      return new DiscordRetryableError(err, null, !isPost);
    }
    return null;
  }

  // --- Network-level: ECONNRESET / ETIMEDOUT / ENOTFOUND / etc ---
  const isNetworkFailure = (code: unknown): boolean =>
    typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code);
  /** Ambiguous only for POST: the request may already have reached Discord. */
  const replaySafeFor = (code: unknown): boolean =>
    !(isPost && typeof code === 'string' && AMBIGUOUS_NETWORK_CODES.has(code));

  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (isNetworkFailure(code)) {
      return new DiscordRetryableError(err, null, replaySafeFor(code));
    }
    // undici wraps low-level errors in `cause` — peek one level deep.
    const inner = (err as Error & { cause?: unknown }).cause;
    if (inner instanceof Error) {
      const innerCode = (inner as Error & { code?: unknown }).code;
      if (isNetworkFailure(innerCode)) {
        return new DiscordRetryableError(err, null, replaySafeFor(innerCode));
      }
    }
  }

  return null;
}
