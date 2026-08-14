import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_ARTIFACT_SCHEMA,
  ACTIVATION_ATTESTATION_REF_SCHEMA,
  activationTrialDigest,
  assertActivationTrialArtifact,
  createActivationTrialArtifact,
} from './activation-artifact.mjs';

const DIGEST = (character) => `sha256:${character.repeat(64)}`;

function trial(overrides = {}) {
  const value = {
    schema_version: ACTIVATION_ARTIFACT_SCHEMA,
    host: 'codex',
    host_version: '0.147.0',
    release: '0.22.0',
    source_commit: 'a'.repeat(40),
    trial_id: 'trial-001',
    execution_mode: 'live',
    result: 'passed',
    phase_durations_ms: {
      install: 100,
      setup: 200,
      client_ready: 300,
      first_request: 400,
      apply: 500,
      evidence: 600,
      restore: 700,
      total: 3_000,
    },
    readiness: {
      install: 'ready',
      setup: 'ready',
      client: 'ready',
      first_request: 'ready',
    },
    terminal_status: 'passed',
    evidence: { apply: 'completed', guild_blueprint_evidence: 'verified' },
    digests: { build: DIGEST('a'), evidence: DIGEST('b'), session: DIGEST('c') },
    safety: {
      secret_free: true,
      caller_owned_bot: true,
      binding_verified: true,
      clean_profile: true,
      isolated_session: true,
      dangerous_permissions: false,
    },
    baseline: {
      restored: true,
      exact: true,
      before_digest: DIGEST('d'),
      after_digest: DIGEST('d'),
    },
    ...overrides,
  };
  return {
    ...value,
    attestation: {
      schema_version: ACTIVATION_ATTESTATION_REF_SCHEMA,
      envelope_digest: DIGEST('e'),
      trial_digest: activationTrialDigest(value),
    },
  };
}

describe('activation trial artifact boundary', () => {
  it('accepts and clones a complete secret-free artifact', () => {
    const source = trial();
    expect(assertActivationTrialArtifact(source)).toBe(source);
    const clone = createActivationTrialArtifact(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
  });

  it('structurally validates test execution artifacts', () => {
    const value = trial({ execution_mode: 'test' });
    expect(assertActivationTrialArtifact(value)).toBe(value);
  });

  it('does not mistake digits inside a validated cryptographic field for a Discord id', () => {
    const sourceCommit = `${'a'.repeat(10)}12345678901234567890${'b'.repeat(10)}`;
    const value = trial({ source_commit: sourceCommit });
    expect(assertActivationTrialArtifact(value)).toBe(value);
  });

  it.each([
    ['raw prompt', { prompt: 'build a gaming server' }],
    ['raw error', { error: 'permission denied' }],
    ['raw config', { config: { env: 'DISCORD_TOKEN' } }],
    ['raw name', { name: 'private guild name' }],
    [
      'unknown nested field',
      {
        safety: {
          secret_free: true,
          caller_owned_bot: true,
          binding_verified: true,
          clean_profile: true,
          isolated_session: true,
          dangerous_permissions: false,
          note: 'x',
        },
      },
    ],
  ])('rejects %s fields', (_label, extra) => {
    expect(() => assertActivationTrialArtifact({ ...trial(), ...extra })).toThrow(/unknown field/);
  });

  it.each([
    ['a Discord snowflake', { host: 'host-1537332825978568744' }],
    ['an absolute Windows path', { host: 'C:\\Users\\runner' }],
    ['an absolute POSIX path', { host: '/tmp/runner' }],
    ['a local relative path', { host: './runner' }],
    [
      'a token-like value',
      {
        trial_id: ['bot abcdefghijklmnopqrst', 'abcdef', 'abcdefghijklmnopqrstuvwxyz'].join('.'),
      },
    ],
  ])('rejects %s', (_label, override) => {
    expect(() => assertActivationTrialArtifact({ ...trial(), ...override })).toThrow();
  });

  it('rejects missing separate guild blueprint evidence even when apply completed', () => {
    const value = { ...trial(), evidence: { apply: 'completed' } };
    expect(() => assertActivationTrialArtifact(value)).toThrow(
      /guild_blueprint_evidence.*required/,
    );
  });

  it('rejects baseline drift and non-integral durations', () => {
    expect(() =>
      assertActivationTrialArtifact({
        ...trial(),
        baseline: { ...trial().baseline, after_digest: DIGEST('e') },
      }),
    ).toThrow(/baseline.*mismatch/);
    expect(() =>
      assertActivationTrialArtifact({
        ...trial(),
        phase_durations_ms: { ...trial().phase_durations_ms, total: -1 },
      }),
    ).toThrow(/invalid duration/);
  });

  it('rejects phases that cannot fit inside the measured total', () => {
    expect(() =>
      assertActivationTrialArtifact({
        ...trial(),
        phase_durations_ms: { ...trial().phase_durations_ms, total: 700 },
      }),
    ).toThrow(/sequential phases|exceeds total/);
  });

  it('rejects a public artifact whose attested trial digest was changed', () => {
    expect(() =>
      assertActivationTrialArtifact({
        ...trial(),
        result: 'failed',
      }),
    ).toThrow(/trial digest mismatch/);
  });

  it('binds every public safety assertion into the attested trial digest', () => {
    const value = trial();
    expect(() =>
      assertActivationTrialArtifact({
        ...value,
        safety: { ...value.safety, caller_owned_bot: false },
      }),
    ).toThrow(/trial digest mismatch/);
  });
});
