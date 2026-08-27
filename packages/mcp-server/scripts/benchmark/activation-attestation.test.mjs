import { describe, expect, it } from 'vitest';

import {
  ACTIVATION_ATTESTATION_CONTEXT,
  ACTIVATION_ATTESTATION_SCHEMA,
  canonicalActivationAttestationDigest,
  canonicalActivationEvidenceDigest,
  createActivationAttestation,
  verifyActivationAttestation,
} from './activation-attestation.mjs';

const KEY = 'private-caller-integrity-key';
const DIGEST = (c) => `sha256:${c.repeat(64)}`;

function envelope(overrides = {}) {
  const evidence = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    status: 'verified',
    evidence_id: DIGEST('9'),
    target: { guild_id: '1537332825978568744', bot_id: '1533998797863256165' },
    count: 7,
  };
  return {
    schema_version: ACTIVATION_ATTESTATION_SCHEMA,
    context: ACTIVATION_ATTESTATION_CONTEXT,
    run_id: 'activation-run-001',
    trial_id: 'codex-trial-001',
    host: 'codex',
    host_version: '1.2.3',
    release: '0.22.0',
    source_commit: 'a'.repeat(40),
    launcher_digest: DIGEST('8'),
    execution_provenance: {
      execution_mode: 'live',
      adapter_id: 'codex-adapter',
      abortable: true,
      package_source: 'verified_npm_provenance',
    },
    binding: { guild_id: '1537332825978568744', bot_id: '1533998797863256165' },
    profile: {
      kind: 'clean_temp',
      config_digest: DIGEST('a'),
      cleanup_verified: true,
      token_persisted: false,
    },
    build: { cli_digest: DIGEST('b'), core_digest: DIGEST('c'), package_digest: DIGEST('d') },
    guild_blueprint_evidence: evidence,
    evidence_digest: canonicalActivationEvidenceDigest(evidence),
    baseline: {
      before_digest: DIGEST('e'),
      after_digest: DIGEST('e'),
      restored: true,
      exact: true,
    },
    public_trial_digest: DIGEST('f'),
    ...overrides,
  };
}

describe('private activation attestation', () => {
  it('creates and verifies a strict HMAC envelope with separate evidence', () => {
    const attestation = createActivationAttestation({ envelope: envelope(), integrityKey: KEY });
    expect(attestation.integrity.algorithm).toBe('hmac-sha256');
    expect(
      verifyActivationAttestation({
        attestation,
        integrityKey: KEY,
        validateActivityEvidence: (value) => value.status === 'verified',
      }),
    ).toEqual(attestation);
    expect(canonicalActivationAttestationDigest(attestation)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('binds evidence digest and invokes the independent validator', () => {
    const attestation = createActivationAttestation({ envelope: envelope(), integrityKey: KEY });
    expect(() =>
      verifyActivationAttestation({
        attestation: { ...attestation, guild_blueprint_evidence: { status: 'failed' } },
        integrityKey: KEY,
        validateActivityEvidence: () => false,
      }),
    ).toThrow(/validation failed|evidence_digest/);
  });

  it('requires the private launcher identity bound by the public trial', () => {
    const { launcher_digest: ignored, ...value } = envelope();
    expect(() => createActivationAttestation({ envelope: value, integrityKey: KEY })).toThrow(
      /launcher_digest.*required/,
    );
  });

  it.each([
    [
      'cyclic evidence',
      () => {
        const value = envelope();
        value.guild_blueprint_evidence.self = value.guild_blueprint_evidence;
        return value;
      },
      /cyclic values/,
    ],
    [
      'deeply nested evidence',
      () => {
        const value = envelope();
        let cursor = value.guild_blueprint_evidence;
        for (let index = 0; index < 13; index += 1) {
          cursor.next = {};
          cursor = cursor.next;
        }
        return value;
      },
      /too deeply nested/,
    ],
  ])('rejects %s before canonicalization', (_label, make, matcher) => {
    expect(() => createActivationAttestation({ envelope: make(), integrityKey: KEY })).toThrow(
      matcher,
    );
  });

  it('rejects evidence for another Discord target', () => {
    const value = envelope();
    const mismatchedEvidence = {
      ...value.guild_blueprint_evidence,
      target: { ...value.guild_blueprint_evidence.target, bot_id: '1533998797863256166' },
    };
    expect(() =>
      createActivationAttestation({
        envelope: {
          ...value,
          guild_blueprint_evidence: mismatchedEvidence,
          evidence_digest: canonicalActivationEvidenceDigest(mismatchedEvidence),
        },
        integrityKey: KEY,
      }),
    ).toThrow(/target.*binding/);
  });

  it.each([
    [
      'wrong key',
      () => ({
        attestation: createActivationAttestation({ envelope: envelope(), integrityKey: KEY }),
        integrityKey: 'wrong-key',
      }),
      /HMAC/,
    ],
    [
      'tampered payload',
      () => ({
        attestation: {
          ...createActivationAttestation({ envelope: envelope(), integrityKey: KEY }),
          release: '0.22.1',
        },
        integrityKey: KEY,
      }),
      /HMAC|evidence/,
    ],
    [
      'unknown top-level field',
      () => ({ envelope: { ...envelope(), private_note: 'x' } }),
      /unknown field/,
    ],
    [
      'token persistence',
      () => ({
        envelope: { ...envelope(), profile: { ...envelope().profile, token_persisted: true } },
      }),
      /token_persisted/,
    ],
    [
      'non-clean profile',
      () => ({ envelope: { ...envelope(), profile: { ...envelope().profile, kind: 'shared' } } }),
      /clean_temp/,
    ],
    [
      'baseline drift',
      () => ({
        envelope: {
          ...envelope(),
          baseline: { ...envelope().baseline, after_digest: DIGEST('9') },
        },
      }),
      /baseline/,
    ],
    [
      'path field in evidence',
      () => ({ envelope: { ...envelope(), guild_blueprint_evidence: { path: 'C:\\secret' } } }),
      /private envelope field|path/,
    ],
  ])('rejects %s', (_label, make, matcher) => {
    const args = make();
    if (args.attestation) expect(() => verifyActivationAttestation(args)).toThrow(matcher);
    else expect(() => createActivationAttestation({ ...args, integrityKey: KEY })).toThrow(matcher);
  });

  it('does not expose private fields through the public digest', () => {
    const first = createActivationAttestation({
      envelope: envelope({ run_id: 'run-a' }),
      integrityKey: KEY,
    });
    const second = createActivationAttestation({
      envelope: envelope({ run_id: 'run-b' }),
      integrityKey: KEY,
    });
    const publicFirst = canonicalActivationAttestationDigest(first);
    expect(publicFirst).toMatch(/^sha256:/);
    expect(publicFirst).not.toContain('run-a');
    expect(publicFirst).not.toBe(canonicalActivationAttestationDigest(second));
  });
});
