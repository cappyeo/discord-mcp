import { DiscordServerError } from './base.js';

export class DiscordServerErrorImpl extends DiscordServerError {
  public readonly code = 'DISCORD_SERVER_ERROR';
  public constructor(
    public readonly status: number,
    public readonly route: string,
  ) {
    super(`Discord ${status} on ${route}`);
    this.recoveryHint =
      'Discord upstream issue. Auto-retry in progress; check status.discord.com if persistent.';
  }
}

export class InternalError extends DiscordServerError {
  public readonly code = 'INTERNAL_ERROR';
  public override recoveryHint = 'Internal MCP server error. Check audit log + Sentry event.';
}

/** A caller-invoked third-party provider could not be reached or returned an invalid response. */
export class ExternalServiceError extends DiscordServerError {
  public readonly code = 'EXTERNAL_SERVICE_UNAVAILABLE';
  public override recoveryHint =
    'Retry later, or open the provider link in a browser and choose an asset manually.';
  public constructor(
    public readonly provider: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(`${provider} is unavailable`, cause);
  }
}

/**
 * Surfaced when cockatiel's circuit breaker is open (or held isolated).
 * Plan 8 D.4: maps `BrokenCircuitError` / `IsolatedCircuitError`.
 *
 * `retriable: true` - the circuit will probe again after `retryAfterMs`.
 */
export class CircuitOpenError extends DiscordServerError {
  public readonly code = 'CIRCUIT_OPEN';
  public override readonly retriable = true;
  public constructor(public readonly retryAfterMs: number) {
    super(`Circuit breaker open - upstream Discord REST is shedding load`);
    this.recoveryHint = `wait ${retryAfterMs}ms`;
  }
}

/**
 * Surfaced when cockatiel's bulkhead has rejected a call because
 * `MCP_BULKHEAD_LIMIT` in-flight requests are already in flight.
 * Plan 8 D.4: maps `BulkheadRejectedError`.
 *
 * `retriable: true` - the agent should back off briefly and retry.  Because
 * `queueSize: 0`, this fires immediately rather than blocking.
 */
export class BulkheadFullError extends DiscordServerError {
  public readonly code = 'BULKHEAD_FULL';
  public override readonly retriable = true;
  public constructor() {
    super('Local concurrency limit exceeded - bulkhead rejected the request');
    this.recoveryHint = 'concurrency limit exceeded; retry shortly';
  }
}
