/**
 * `isOtlpSelfTrace` is the predicate that stops the tracer from tracing its own
 * exports. Without it each OTLP export request produces a span, which the next
 * batch flushes, which produces a span — an unbounded feedback loop against the
 * collector.
 *
 * It had zero coverage: the existing OTel suite asserted that undici's
 * `ignoreRequestHook` option works, which is the upstream library's contract,
 * not ours.
 */
import { describe, expect, it } from 'vitest';
import { isOtlpSelfTrace } from './otel.js';

describe('isOtlpSelfTrace', () => {
  it('suppresses all three OTLP signal paths', () => {
    for (const p of ['/v1/traces', '/v1/metrics', '/v1/logs']) {
      expect(isOtlpSelfTrace(`http://localhost:4318${p}`), p).toBe(true);
    }
  });

  it('suppresses a collector behind a prefix path', () => {
    // Common behind an ingress or an APM vendor's ingest route.
    expect(isOtlpSelfTrace('https://otlp.example.com/otel/v1/traces')).toBe(true);
  });

  it('does not suppress Discord REST calls', () => {
    expect(isOtlpSelfTrace('https://discord.com/api/v10/channels/123/messages')).toBe(false);
    expect(isOtlpSelfTrace('https://discord.com/api/v10/users/@me')).toBe(false);
  });

  it('does not suppress a Discord route that merely contains "v1"', () => {
    // Guards the substring match from over-reaching: `/v1/` alone is not enough.
    expect(isOtlpSelfTrace('https://discord.com/api/v10/guilds/123/regions')).toBe(false);
  });
});
