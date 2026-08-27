import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_ARTIFACT_SCHEMA,
  ACTIVATION_ATTESTATION_REF_SCHEMA,
  activationTrialDigest,
} from './activation-artifact.mjs';
import {
  ACTIVATION_ATTESTATION_CONTEXT,
  ACTIVATION_ATTESTATION_SCHEMA,
  canonicalActivationAttestationDigest,
  canonicalActivationEvidenceDigest,
  createActivationAttestation,
} from './activation-attestation.mjs';
import {
  ACTIVATION_BUNDLE_SCHEMA,
  ACTIVATION_MAX_DURATION_MS,
  ACTIVATION_VERIFIER_SCHEMA,
  main,
  PRODUCTION_ACTIVATION_HOSTS,
  verifyActivationTrialAggregate,
  verifyActivationTrialsBundle,
  verifyProductionActivationMatrix,
} from './verify-activation-trials.mjs';

const DIGEST = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function trial(index, overrides = {}) {
  const value = {
    schema_version: ACTIVATION_ARTIFACT_SCHEMA,
    host: 'codex',
    host_version: '0.147.0',
    release: '0.22.0',
    source_commit: 'a'.repeat(40),
    trial_id: `trial-${String(index).padStart(3, '0')}`,
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
      total: 10_000 + index * 100,
    },
    readiness: {
      install: 'ready',
      setup: 'ready',
      client: 'ready',
      first_request: 'ready',
    },
    terminal_status: 'passed',
    evidence: { apply: 'completed', guild_blueprint_evidence: 'verified' },
    digests: {
      build: DIGEST('public-package'),
      evidence: DIGEST(`evidence-${index}`),
      launcher: DIGEST('codex-launcher'),
      session: DIGEST(`session-${index}`),
    },
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
      before_digest: DIGEST('baseline'),
      after_digest: DIGEST('baseline'),
    },
    ...overrides,
  };
  return {
    ...value,
    attestation: {
      schema_version: ACTIVATION_ATTESTATION_REF_SCHEMA,
      envelope_digest: DIGEST(`envelope-${value.host}-${index}`),
      trial_digest: activationTrialDigest(value),
    },
  };
}

function three(overrides = []) {
  return [1, 2, 3].map((index) => trial(index, overrides[index - 1]));
}

const BINDING = { guildId: '1537332825978568744', botId: '1533998797863256165' };
const KEY = 'activation-test-integrity-key';

function attestedBundle({
  reuseEvidence = false,
  host = 'codex',
  hostVersion = '0.147.0',
  runId = 'activation-run-001',
  trialPrefix = 'trial',
  identityNamespace = '',
} = {}) {
  const evidenceDirPromise = mkdtemp(join(tmpdir(), 'discord-mcp-activation-verifier-'));
  return evidenceDirPromise.then(async (root) => {
    const evidenceDir = join(root, 'evidence');
    await mkdir(evidenceDir);
    const publicTrials = [];
    const namespace = identityNamespace === '' ? '' : `${identityNamespace}-`;
    const sessionNamespace = identityNamespace === '' ? '' : `${host}-`;
    for (const index of [1, 2, 3]) {
      const evidence = {
        schema_version: 'guild_blueprint_activity_evidence.v1',
        status: 'verified',
        evidence_id: DIGEST(`${namespace}evidence-record-${reuseEvidence ? 1 : index}`),
        target: { guild_id: BINDING.guildId, bot_id: BINDING.botId },
      };
      const value = trial(index, {
        host,
        host_version: hostVersion,
        trial_id: `${trialPrefix}-${String(index).padStart(3, '0')}`,
        digests: {
          build: DIGEST('public-package'),
          evidence: evidence.evidence_id,
          launcher: DIGEST(`${host}-launcher`),
          session: DIGEST(`${sessionNamespace}session-${index}`),
        },
      });
      const attestation = createActivationAttestation({
        envelope: {
          schema_version: ACTIVATION_ATTESTATION_SCHEMA,
          context: ACTIVATION_ATTESTATION_CONTEXT,
          run_id: runId,
          trial_id: value.trial_id,
          host: value.host,
          host_version: value.host_version,
          release: value.release,
          source_commit: value.source_commit,
          launcher_digest: value.digests.launcher,
          execution_provenance: {
            execution_mode: value.execution_mode,
            adapter_id: `${host}-adapter`,
            abortable: true,
            package_source: 'verified_npm_provenance',
          },
          binding: { guild_id: BINDING.guildId, bot_id: BINDING.botId },
          profile: {
            kind: 'clean_temp',
            config_digest: DIGEST('config'),
            cleanup_verified: true,
            token_persisted: false,
          },
          build: {
            cli_digest: DIGEST('cli'),
            core_digest: DIGEST('core'),
            package_digest: value.digests.build,
          },
          guild_blueprint_evidence: evidence,
          evidence_digest: canonicalActivationEvidenceDigest(evidence),
          baseline: value.baseline,
          public_trial_digest: value.attestation.trial_digest,
        },
        integrityKey: KEY,
      });
      value.attestation.envelope_digest = canonicalActivationAttestationDigest(attestation);
      await writeFile(
        join(evidenceDir, `${value.attestation.envelope_digest.slice('sha256:'.length)}.json`),
        JSON.stringify(attestation),
      );
      publicTrials.push(value);
    }
    const inputPath = join(root, 'bundle.json');
    await writeFile(
      inputPath,
      JSON.stringify({ schema_version: ACTIVATION_BUNDLE_SCHEMA, trials: publicTrials }),
    );
    return { root, inputPath, evidenceDir, publicTrials, runId };
  });
}

async function attestedProductionMatrix({ sharedEvidenceHosts = [] } = {}) {
  const fixtures = await Promise.all(
    PRODUCTION_ACTIVATION_HOSTS.map((host) =>
      attestedBundle({
        host,
        hostVersion: '1.0.0',
        runId: `${host}-activation-run-001`,
        trialPrefix: `${host}-trial`,
        identityNamespace: sharedEvidenceHosts.includes(host) ? 'shared' : host,
      }),
    ),
  );
  return {
    fixtures,
    campaigns: Object.fromEntries(
      fixtures.map((fixture, index) => [
        PRODUCTION_ACTIVATION_HOSTS[index],
        {
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          expectedRunId: fixture.runId,
        },
      ]),
    ),
    async cleanup() {
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })),
      );
    },
  };
}

describe('activation trial aggregate verifier', () => {
  it('verifies exactly three unique passing trials and nearest-rank p90', () => {
    const result = verifyActivationTrialAggregate({ trials: three() });
    expect(result).toEqual({
      schema_version: ACTIVATION_VERIFIER_SCHEMA,
      artifact_schema: ACTIVATION_ARTIFACT_SCHEMA,
      verified: true,
      release: '0.22.0',
      source_commit: 'a'.repeat(40),
      build_digest: DIGEST('public-package'),
      host_count: 1,
      hosts: [
        {
          host: 'codex',
          host_version: '0.147.0',
          release: '0.22.0',
          source_commit: 'a'.repeat(40),
          build_digest: DIGEST('public-package'),
          launcher_digest: DIGEST('codex-launcher'),
          trial_count: 3,
          trial_ids: ['trial-001', 'trial-002', 'trial-003'],
          durations_ms: { median: 10_200, p90: 10_300 },
        },
      ],
    });
  });

  it('rejects reuse of one Activity Evidence identity across trials', () => {
    const trials = three([
      {},
      {},
      {
        digests: {
          ...trial(3).digests,
          evidence: DIGEST('evidence-1'),
        },
      },
    ]);
    expect(() => verifyActivationTrialAggregate({ trials })).toThrow(
      /reuses Activity Evidence identity/,
    );
  });

  it('rejects executable byte drift across one host campaign', () => {
    const trials = three([
      {},
      {},
      {
        digests: {
          ...trial(3).digests,
          launcher: DIGEST('changed-launcher'),
        },
      },
    ]);
    expect(() => verifyActivationTrialAggregate({ trials })).toThrow(/mixes launcher identities/);
  });

  it('verifies every host independently when multiple hosts are present', () => {
    const trials = [
      ...three(),
      ...[1, 2, 3].map((index) =>
        trial(index, {
          host: 'claude-code',
          host_version: '2.1.228',
          trial_id: `claude-trial-${index}`,
          digests: {
            build: DIGEST('public-package'),
            evidence: DIGEST(`claude-evidence-${index}`),
            launcher: DIGEST('claude-launcher'),
            session: DIGEST(`claude-session-${index}`),
          },
        }),
      ),
    ];
    expect(
      verifyActivationTrialAggregate({ trials, expectedHosts: ['codex', 'claude-code'] }),
    ).toMatchObject({
      verified: true,
      host_count: 2,
    });
  });

  it('rejects test execution artifacts at the authoritative aggregate boundary', () => {
    expect(() =>
      verifyActivationTrialAggregate({ trials: three([{ execution_mode: 'test' }]) }),
    ).toThrow(/non-live/);
  });

  it('rejects a trial id reused by different hosts', () => {
    expect(() =>
      verifyActivationTrialAggregate({
        trials: [
          ...three(),
          ...[1, 2, 3].map((index) =>
            trial(index, {
              host: 'claude-code',
              host_version: '2.1.228',
              trial_id: index === 1 ? 'trial-001' : `claude-trial-${index}`,
            }),
          ),
        ],
      }),
    ).toThrow(/duplicate trial ids/);
  });

  it.each([
    ['fewer than three trials', three().slice(0, 2)],
    ['a duplicate trial id', [trial(1), trial(1), trial(2)]],
    ['a failed result', three([{ result: 'failed' }])],
    [
      'apply-only evidence',
      three([{ evidence: { apply: 'completed', guild_blueprint_evidence: 'failed' } }]),
    ],
    [
      'unverified readiness',
      three([
        {
          readiness: {
            install: 'ready',
            setup: 'ready',
            client: 'blocked',
            first_request: 'ready',
          },
        },
      ]),
    ],
    [
      'dangerous permission allowance',
      three([
        {
          safety: {
            secret_free: true,
            caller_owned_bot: true,
            binding_verified: true,
            clean_profile: true,
            isolated_session: true,
            dangerous_permissions: true,
          },
        },
      ]),
    ],
    [
      'baseline not restored',
      three([
        {
          baseline: {
            restored: false,
            exact: false,
            before_digest: DIGEST('baseline'),
            after_digest: DIGEST('baseline'),
          },
        },
      ]),
    ],
  ])('fails closed for %s', (_label, value) => {
    expect(() => verifyActivationTrialAggregate({ trials: value })).toThrow();
  });

  it('rejects a duration exactly at the strict ten-minute boundary', () => {
    const value = three([
      {},
      {},
      {
        phase_durations_ms: {
          ...trial(3).phase_durations_ms,
          total: ACTIVATION_MAX_DURATION_MS,
        },
      },
    ]);
    expect(() => verifyActivationTrialAggregate({ trials: value })).toThrow(/duration threshold/);
  });

  it('does not allow callers to relax the ten-minute campaign SLA', () => {
    expect(() =>
      verifyActivationTrialAggregate({
        trials: [trial(1), trial(2), trial(3)],
        maxDurationMs: 600_001,
      }),
    ).toThrow(/between 1 and 600000/);
  });

  it('rejects a duration above the boundary even when median remains low', () => {
    const value = three([
      {},
      {},
      {
        phase_durations_ms: {
          ...trial(3).phase_durations_ms,
          total: ACTIVATION_MAX_DURATION_MS + 1,
        },
      },
    ]);
    expect(() => verifyActivationTrialAggregate({ trials: value })).toThrow(/duration threshold/);
  });

  it('rejects host mismatch and mixed releases', () => {
    expect(() =>
      verifyActivationTrialAggregate({ trials: three(), expectedHosts: ['cursor'] }),
    ).toThrow(/hosts/);
    expect(() =>
      verifyActivationTrialAggregate({
        trials: three([{ release: '0.22.1' }]),
      }),
    ).toThrow(/release/);
  });
});

describe('production activation host matrix verifier', () => {
  it('independently verifies all five hosts and aggregates all fifteen trials', async () => {
    const matrix = await attestedProductionMatrix();
    try {
      const result = await verifyProductionActivationMatrix({
        campaigns: matrix.campaigns,
        integrityKey: KEY,
        expectedBinding: BINDING,
        expectedRelease: '0.22.0',
        expectedCommit: 'a'.repeat(40),
        expectedBuildDigest: DIGEST('public-package'),
        validateActivityEvidence: (value) => value.status === 'verified',
      });
      expect(result).toMatchObject({
        schema_version: ACTIVATION_VERIFIER_SCHEMA,
        verified: true,
        host_count: 5,
      });
      expect(result.hosts.map(({ host }) => host).sort()).toEqual(
        [...PRODUCTION_ACTIVATION_HOSTS].sort(),
      );
      expect(result.hosts.reduce((total, host) => total + host.trial_count, 0)).toBe(15);
      expect(JSON.stringify(result)).not.toContain(BINDING.guildId);
      expect(JSON.stringify(result)).not.toContain(BINDING.botId);
    } finally {
      await matrix.cleanup();
    }
  });

  it('rejects a missing host before treating a partial matrix as production evidence', async () => {
    const matrix = await attestedProductionMatrix();
    try {
      delete matrix.campaigns['grok-cli'];
      await expect(
        verifyProductionActivationMatrix({
          campaigns: matrix.campaigns,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRelease: '0.22.0',
          expectedCommit: 'a'.repeat(40),
          expectedBuildDigest: DIGEST('public-package'),
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/campaigns\.grok-cli/);
    } finally {
      await matrix.cleanup();
    }
  });

  it('rejects Activity Evidence reused across independently valid host campaigns', async () => {
    const matrix = await attestedProductionMatrix({
      sharedEvidenceHosts: ['codex', 'claude-code'],
    });
    try {
      await expect(
        verifyProductionActivationMatrix({
          campaigns: matrix.campaigns,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRelease: '0.22.0',
          expectedCommit: 'a'.repeat(40),
          expectedBuildDigest: DIGEST('public-package'),
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/reuses Activity Evidence identity/);
    } finally {
      await matrix.cleanup();
    }
  });
});

describe('activation bundle verifier', () => {
  it('verifies three public trials against private HMAC envelopes', async () => {
    const fixture = await attestedBundle();
    try {
      const result = await verifyActivationTrialsBundle({
        inputPath: fixture.inputPath,
        evidenceDir: fixture.evidenceDir,
        integrityKey: KEY,
        expectedBinding: BINDING,
        expectedRunId: 'activation-run-001',
        expectedHosts: ['codex'],
        expectedRelease: '0.22.0',
        expectedCommit: 'a'.repeat(40),
        expectedBuildDigest: DIGEST('public-package'),
        validateActivityEvidence: (value) => value.status === 'verified',
      });
      expect(result.verified).toBe(true);
      expect(result.hosts[0].trial_count).toBe(3);
      expect(JSON.stringify(result)).not.toContain(BINDING.guildId);
      expect(JSON.stringify(result)).not.toContain(BINDING.botId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects reused Activity Evidence in private authoritative envelopes', async () => {
    const fixture = await attestedBundle({ reuseEvidence: true });
    try {
      await expect(
        verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRunId: 'activation-run-001',
          expectedHosts: ['codex'],
          expectedRelease: '0.22.0',
          expectedCommit: 'a'.repeat(40),
          expectedBuildDigest: DIGEST('public-package'),
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/reuses Activity Evidence digest/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('requires the expected campaign run id', async () => {
    const fixture = await attestedBundle();
    try {
      await expect(
        verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRunId: 'activation-run-other',
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/expected run id/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['public mode', { execution_mode: 'test' }, /execution provenance/],
    ['abortability', { abortable: false }, /authoritative/],
    ['package provenance', { package_source: 'test_fixture' }, /authoritative/],
  ])('requires authoritative private execution provenance: %s', async (_label, override, matcher) => {
    const fixture = await attestedBundle();
    try {
      const publicTrial = fixture.publicTrials[0];
      const oldFile = join(
        fixture.evidenceDir,
        `${publicTrial.attestation.envelope_digest.slice(7)}.json`,
      );
      const current = JSON.parse(await readFile(oldFile, 'utf8'));
      const { integrity: ignored, ...envelope } = current;
      const changed = createActivationAttestation({
        envelope: {
          ...envelope,
          execution_provenance: { ...envelope.execution_provenance, ...override },
        },
        integrityKey: KEY,
      });
      const changedDigest = canonicalActivationAttestationDigest(changed);
      await rm(oldFile);
      await writeFile(
        join(fixture.evidenceDir, `${changedDigest.slice(7)}.json`),
        JSON.stringify(changed),
      );
      publicTrial.attestation.envelope_digest = changedDigest;
      await writeFile(
        fixture.inputPath,
        JSON.stringify({
          schema_version: ACTIVATION_BUNDLE_SCHEMA,
          trials: fixture.publicTrials,
        }),
      );
      await expect(
        verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRunId: 'activation-run-001',
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(matcher);
      void ignored;
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'wrong HMAC',
      async (fixture) => {
        const file = join(
          fixture.evidenceDir,
          `${fixture.publicTrials[0].attestation.envelope_digest.slice(7)}.json`,
        );
        const value = JSON.parse(await readFile(file, 'utf8'));
        value.integrity.digest = '0'.repeat(64);
        await writeFile(file, JSON.stringify(value));
      },
    ],
    [
      'missing envelope',
      async (fixture) => {
        const file = join(
          fixture.evidenceDir,
          `${fixture.publicTrials[0].attestation.envelope_digest.slice(7)}.json`,
        );
        await rm(file);
      },
    ],
    [
      'malformed envelope',
      async (fixture) => {
        const file = join(
          fixture.evidenceDir,
          `${fixture.publicTrials[0].attestation.envelope_digest.slice(7)}.json`,
        );
        await writeFile(file, '{not-json');
      },
    ],
    [
      'public/private mismatch',
      async (fixture) => {
        fixture.publicTrials[0].host_version = '9.9.9';
        await writeFile(
          fixture.inputPath,
          JSON.stringify({
            schema_version: ACTIVATION_BUNDLE_SCHEMA,
            trials: fixture.publicTrials,
          }),
        );
      },
    ],
    [
      'wrong target binding',
      async (fixture) => {
        await verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          integrityKey: KEY,
          expectedBinding: { ...BINDING, botId: '1533998797863256166' },
          validateActivityEvidence: (value) => value.status === 'verified',
        });
      },
    ],
    [
      'missing separate evidence',
      async (fixture) => {
        const file = join(
          fixture.evidenceDir,
          `${fixture.publicTrials[0].attestation.envelope_digest.slice(7)}.json`,
        );
        const value = JSON.parse(await readFile(file, 'utf8'));
        value.guild_blueprint_evidence.status = 'failed';
        await writeFile(file, JSON.stringify(value));
      },
    ],
    [
      'mixed private campaign runs',
      async (fixture) => {
        const publicTrial = fixture.publicTrials[1];
        const oldFile = join(
          fixture.evidenceDir,
          `${publicTrial.attestation.envelope_digest.slice(7)}.json`,
        );
        const current = JSON.parse(await readFile(oldFile, 'utf8'));
        const { integrity: ignored, ...envelope } = current;
        const changed = createActivationAttestation({
          envelope: { ...envelope, run_id: 'activation-run-other' },
          integrityKey: KEY,
        });
        const changedDigest = canonicalActivationAttestationDigest(changed);
        await rm(oldFile);
        await writeFile(
          join(fixture.evidenceDir, `${changedDigest.slice(7)}.json`),
          JSON.stringify(changed),
        );
        publicTrial.attestation.envelope_digest = changedDigest;
        await writeFile(
          fixture.inputPath,
          JSON.stringify({
            schema_version: ACTIVATION_BUNDLE_SCHEMA,
            trials: fixture.publicTrials,
          }),
        );
        void ignored;
      },
    ],
  ])('fails closed for %s', async (_label, mutate) => {
    const fixture = await attestedBundle();
    try {
      if (_label === 'wrong target binding') {
        await expect(mutate(fixture)).rejects.toThrow();
      } else {
        await mutate(fixture);
        await expect(
          verifyActivationTrialsBundle({
            inputPath: fixture.inputPath,
            evidenceDir: fixture.evidenceDir,
            integrityKey: KEY,
            expectedBinding: BINDING,
            expectedRunId: 'activation-run-001',
            validateActivityEvidence: (value) => value.status === 'verified',
          }),
        ).rejects.toThrow();
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an evidence directory symlink', async () => {
    if (process.platform === 'win32') return;
    const fixture = await attestedBundle();
    const link = join(fixture.root, 'evidence-link');
    try {
      await symlink(fixture.evidenceDir, link, 'dir');
      await expect(
        verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: link,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRunId: 'activation-run-001',
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/directory/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized private envelope before parsing', async () => {
    const fixture = await attestedBundle();
    try {
      const file = join(
        fixture.evidenceDir,
        `${fixture.publicTrials[0].attestation.envelope_digest.slice(7)}.json`,
      );
      await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 0x20));
      await expect(
        verifyActivationTrialsBundle({
          inputPath: fixture.inputPath,
          evidenceDir: fixture.evidenceDir,
          integrityKey: KEY,
          expectedBinding: BINDING,
          expectedRunId: 'activation-run-001',
          validateActivityEvidence: (value) => value.status === 'verified',
        }),
      ).rejects.toThrow(/size bound/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps the CLI strict and emits no private values', async () => {
    const output = [];
    const code = await main({
      argv: ['--unknown', 'value'],
      env: {
        DISCORD_TOKEN: KEY,
        DISCORD_ACTIVATION_GUILD_ID: BINDING.guildId,
        DISCORD_EXPECTED_BOT_ID: BINDING.botId,
      },
      stdout: { write: (value) => output.push(value) },
    });
    expect(code).toBe(1);
    const text = output.join('');
    expect(JSON.parse(text)).toEqual({
      schema_version: ACTIVATION_VERIFIER_SCHEMA,
      verified: false,
      error: 'activation verification failed',
    });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(BINDING.guildId);
    expect(text).not.toContain(BINDING.botId);
  });

  it('requires release, commit, build, and host expectations at the CLI boundary', async () => {
    const output = [];
    const code = await main({
      argv: ['--input', 'relative.json', '--evidence-dir', 'relative-evidence'],
      env: {
        DISCORD_TOKEN: KEY,
        DISCORD_ACTIVATION_GUILD_ID: BINDING.guildId,
        DISCORD_EXPECTED_BOT_ID: BINDING.botId,
      },
      stdout: { write: (value) => output.push(value) },
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.join(''))).toMatchObject({ verified: false });
  });
});
