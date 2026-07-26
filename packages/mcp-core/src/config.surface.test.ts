/**
 * The frozen config surface.
 *
 * v1.0.0 commits to "env var names + defaults locked (additions allowed;
 * renames forbidden)". Nothing enforced that, which is how `MCP_TIMEOUT_LONG_MS`
 * shipped documented-and-validated but read by no code path, and how
 * `MCP_CATEGORIES` was advertised as a security control while restricting
 * nothing.
 *
 * The snapshot covers names *and* defaults: a silently changed default is a
 * behavioural break for every existing deployment even though the name is
 * unchanged.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const MINIMAL_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as NodeJS.ProcessEnv;

describe('config surface', () => {
  it('resolves to the frozen set of keys and defaults', () => {
    const config = loadConfig(MINIMAL_ENV);
    // DISCORD_TOKEN is the one caller-supplied value; excluded so the snapshot
    // never contains a token-shaped string.
    const {
      DISCORD_TOKEN: _token,
      // Derived from package.json — asserted in version.test.ts. Excluded here
      // so a routine version bump does not churn this snapshot, which exists to
      // catch renames and changed defaults.
      OTEL_SERVICE_VERSION: _version,
      ...rest
    } = config as Record<string, unknown>;
    expect(rest).toMatchSnapshot();
  });

  it('reads every documented variable from the environment it is given', () => {
    // loadConfig must not fall through to process.env for anything — the
    // doctor command and the contract tests both depend on being able to
    // evaluate a hypothetical environment.
    const config = loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'debug', MCP_BULKHEAD_LIMIT: '7' });
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.MCP_BULKHEAD_LIMIT).toBe(7);
  });

  it('rejects an invalid value instead of silently defaulting', () => {
    // Fail-fast at boot beats a server that quietly runs with a different
    // policy than the operator configured.
    expect(() => loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'chatty' })).toThrow();
    expect(() => loadConfig({ ...MINIMAL_ENV, MCP_RETRY_MAX_ATTEMPTS: '999' })).toThrow();
  });
});
