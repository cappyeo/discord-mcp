import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { BenchmarkRestoreFailure } from './baseline-lifecycle.mjs';
import {
  BenchmarkQuarantineError,
  CONTROLLED_BOT_ID,
  CONTROLLED_GUILD_IDS,
  createControlledReuseManifest,
  runBenchmarkCampaign,
} from './campaign.mjs';
import { createBenchmarkReport } from './manifest.mjs';
import { BenchmarkQuotaPreflightError } from './quota-preflight.mjs';

const COMMIT = 'babe8518767270733e5442643690cac13f94e473';
const FINGERPRINTS = Object.fromEntries(
  CONTROLLED_GUILD_IDS.map((guildId, index) => [guildId, `sha256:${String(index + 1).repeat(64)}`]),
);
const CANARY_CHANNEL_IDS = Object.fromEntries(
  CONTROLLED_GUILD_IDS.map((guildId, index) => [guildId, `77700077700077700${index}`]),
);

function manifest() {
  return createControlledReuseManifest({
    runId: 'campaign-test',
    commit: COMMIT,
    builtCli: {
      entrypoint: 'packages/mcp-server/dist/cli.js',
      sha256: `sha256:${'a'.repeat(64)}`,
      source_commit: COMMIT,
    },
  });
}

function result(trial, serious = []) {
  return {
    trial_id: trial.trial_id,
    mode: trial.mode,
    guild_id: trial.guild_id,
    eligible: true,
    terminal_status: 'complete',
    oracle_match: serious.length === 0,
    snapshot_oracle_pass: true,
    blueprint_oracle_match: true,
    audit_oracle_pass: true,
    serious_permission_failures: serious,
    functional_failures: [],
    plan_snapshot_unchanged: true,
    forced_resume_observed: trial.mode === 'forced_resume' ? true : null,
    operations_planned: 25,
    apply_calls: trial.mode === 'forced_resume' ? 2 : 1,
    restart_count: trial.mode === 'forced_resume' ? 2 : 1,
    replay_status: 'already_current',
    evidence_status: 'verified',
    audit_entry_count: 20,
    audit_trail_complete: true,
    verified_counts: {
      roles: 4,
      categories: 5,
      channels: 16,
      automod_rules: 3,
      publications: 3,
      onboarding_prompts: 3,
    },
  };
}

function safetyCases() {
  const common = {
    guard_guild_id: CONTROLLED_GUILD_IDS[0],
    active_bot_id: CONTROLLED_BOT_ID,
    snapshot_unchanged: true,
    audit_entry_count: 0,
    mutation_count: 0,
  };
  return [
    {
      ...common,
      case: 'wrong_bot',
      passed: true,
      target_guild_id: CONTROLLED_GUILD_IDS[0],
      supplied_bot_id: (BigInt(CONTROLLED_BOT_ID) + 1n).toString(),
      blocked_before_discord: true,
      blocker_code: 'EXPECTED_BOT_MISMATCH',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
    },
    {
      ...common,
      case: 'wrong_guild',
      passed: true,
      target_guild_id: CONTROLLED_GUILD_IDS[1],
      supplied_bot_id: CONTROLLED_BOT_ID,
      blocked_before_discord: true,
      blocker_code: 'GUILD_NOT_ALLOWED',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
    },
    {
      ...common,
      case: 'write_preview',
      passed: true,
      target_guild_id: CONTROLLED_GUILD_IDS[0],
      supplied_bot_id: CONTROLLED_BOT_ID,
      blocked_before_discord: false,
      blocker_code: null,
      plan_status: 'ready',
      target_readback: 'passed',
      operations_planned: 25,
    },
  ];
}

function quotaEvidence(guildId, overrides = {}) {
  const index = CONTROLLED_GUILD_IDS.indexOf(guildId);
  return {
    schema_version: 'discord-mcp.benchmark-quota-preflight.v1',
    guild_id: guildId,
    bot_id: CONTROLLED_BOT_ID,
    status: 'ready',
    create_attempts: 1,
    waited_ms: 0,
    retry_after_ms: null,
    role_id: `77700077700077800${index}`,
    baseline_fingerprint_before: FINGERPRINTS[guildId],
    baseline_fingerprint_after: FINGERPRINTS[guildId],
    baseline_restored: true,
    ...overrides,
  };
}

function harness({
  seriousAt = null,
  failedAt = [],
  quotaUnavailableGuild = null,
  quotaUnavailableEvidence = {},
  quotaErrorGuild = null,
  restoreFailure = false,
  restoreFailuresBeforeSuccess = 0,
  preflightFailuresBeforeSuccess = 0,
  ambiguousRestoreFailure = false,
  deterministicRestoreFailure = false,
  executionRejectedRestoreFailure = false,
  unclassifiedRestoreFailure = false,
  baselineFailure = false,
} = {}) {
  const failedRestoreAttempts = restoreFailure
    ? Number.POSITIVE_INFINITY
    : restoreFailuresBeforeSuccess;
  const artifacts = new Map();
  const states = [];
  const restores = [];
  const calls = [];
  const restoreProof = Object.freeze({});
  return {
    artifacts,
    states,
    restores,
    calls,
    dependencies: {
      async verifyBaseline({ baseline }) {
        calls.push(['verify', baseline.guild_id]);
        if (baselineFailure) throw new Error('baseline drift');
        if (restores.length > 0 && restores.length <= failedRestoreAttempts)
          throw new Error('restore drift');
        return {
          verified: true,
          guild_id: baseline.guild_id,
          bot_id: baseline.bot_id,
          fingerprint: baseline.fingerprint,
        };
      },
      async runQuotaPreflight({ baseline, guildId, botId, runId }) {
        calls.push(['quota', guildId]);
        assert.equal(baseline.guild_id, guildId);
        assert.equal(botId, CONTROLLED_BOT_ID);
        assert.equal(runId, 'campaign-test');
        if (guildId === quotaErrorGuild) {
          throw new BenchmarkQuotaPreflightError(
            'PREFLIGHT_ROLE_DELETE_FAILED',
            quotaEvidence(guildId, {
              status: null,
              baseline_fingerprint_after: null,
              baseline_restored: false,
            }),
          );
        }
        if (guildId === quotaUnavailableGuild) {
          return quotaEvidence(guildId, {
            status: 'unavailable',
            retry_after_ms: 172_207_050,
            role_id: null,
            ...quotaUnavailableEvidence,
          });
        }
        return quotaEvidence(guildId);
      },
      async runSafetyCases(options) {
        calls.push(['safety']);
        assert.equal(options.guardMessageChannelId, CANARY_CHANNEL_IDS[CONTROLLED_GUILD_IDS[0]]);
        assert.equal(
          options.wrongGuildMessageChannelId,
          CANARY_CHANNEL_IDS[CONTROLLED_GUILD_IDS[1]],
        );
        return safetyCases();
      },
      async runTrial({ trial, baselineMessageChannelId }) {
        calls.push(['trial', trial.trial_id]);
        assert.equal(baselineMessageChannelId, CANARY_CHANNEL_IDS[trial.guild_id]);
        const trialResult = result(
          trial,
          trial.trial_id === seriousAt ? [{ code: 'GENERATED_ROLE_DANGEROUS_PERMISSION' }] : [],
        );
        if (failedAt.includes(trial.trial_id)) {
          trialResult.oracle_match = false;
          trialResult.snapshot_oracle_pass = false;
          trialResult.blueprint_oracle_match = false;
          trialResult.audit_oracle_pass = false;
          trialResult.functional_failures = [{ code: 'ORACLE_MISMATCH' }];
        }
        return {
          result: trialResult,
          cleanup: {
            guild_id: trial.guild_id,
            bot_id: trial.expected_bot_id,
            bindings: {
              roles: { member: `77700077700077${trial.trial_id.slice(-2)}` },
              categories: {},
              channels: {},
              automod_rules: {},
              publications: {},
            },
            publication_targets: [],
          },
        };
      },
      async restoreBaseline({ baseline, cleanup, retryProof }) {
        restores.push({ baseline, cleanup, retryProof });
        if (deterministicRestoreFailure) {
          throw new BenchmarkRestoreFailure('RESTORE_SAFETY_VIOLATION');
        }
        if (executionRejectedRestoreFailure) {
          throw new BenchmarkRestoreFailure('RESTORE_EXECUTION_REJECTED', undefined, restoreProof);
        }
        if (unclassifiedRestoreFailure) throw new Error('unclassified restore failure');
        if (restores.length <= preflightFailuresBeforeSuccess) {
          throw new BenchmarkRestoreFailure('RESTORE_PREFLIGHT_UNAVAILABLE');
        }
        if (restores.length <= failedRestoreAttempts || ambiguousRestoreFailure) {
          throw new BenchmarkRestoreFailure('RESTORE_EXECUTION_AMBIGUOUS', undefined, restoreProof);
        }
        return { restored: true, fingerprint: baseline.fingerprint, retryProof: restoreProof };
      },
      async sleep(milliseconds) {
        calls.push(['sleep', milliseconds]);
      },
      createReport: createBenchmarkReport,
      async writeArtifact(path, value) {
        calls.push(['artifact', path]);
        if (artifacts.has(path)) throw new Error('artifact overwrite');
        artifacts.set(path, structuredClone(value));
      },
      async createStateDirectory(name) {
        calls.push(['state', name]);
        assert.equal(states.includes(name), false);
        states.push(name);
        return `C:/state/${name}`;
      },
    },
  };
}

function input(test) {
  return {
    manifest: manifest(),
    baselines: Object.fromEntries(
      CONTROLLED_GUILD_IDS.map((guildId) => [
        guildId,
        {
          guild_id: guildId,
          bot_id: CONTROLLED_BOT_ID,
          fingerprint: FINGERPRINTS[guildId],
          canary: { channel_id: CANARY_CHANNEL_IDS[guildId] },
        },
      ]),
    ),
    request: 'Build a professional gaming Discord server',
    cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
    cwd: 'C:/repo',
    token: 'benchmark-token-never-written',
    trialDependencies: {},
    dependencies: test.dependencies,
  };
}

describe('real benchmark campaign', () => {
  it('creates exactly 10 full and 10 forced-resume trials across two guilds', () => {
    const value = manifest();
    assert.equal(value.trials.filter((trial) => trial.mode === 'full').length, 10);
    assert.equal(value.trials.filter((trial) => trial.mode === 'forced_resume').length, 10);
    assert.deepEqual(value.guild_diversity.trials_per_guild, {
      [CONTROLLED_GUILD_IDS[0]]: 10,
      [CONTROLLED_GUILD_IDS[1]]: 10,
    });
  });

  it('rejects manifests outside the exact controlled target boundary before campaign work', async () => {
    const foreignGuildId = (BigInt(CONTROLLED_GUILD_IDS[0]) + 1n).toString();
    const foreignBotId = (BigInt(CONTROLLED_BOT_ID) + 1n).toString();

    const guildTest = harness();
    const guildManifest = structuredClone(manifest());
    guildManifest.trials = guildManifest.trials.map((trial) => ({
      ...trial,
      guild_id: trial.guild_id === CONTROLLED_GUILD_IDS[0] ? foreignGuildId : trial.guild_id,
    }));
    guildManifest.guild_diversity.trials_per_guild = {
      [foreignGuildId]: 10,
      [CONTROLLED_GUILD_IDS[1]]: 10,
    };
    const guildInput = input(guildTest);
    guildInput.manifest = guildManifest;
    await assert.rejects(runBenchmarkCampaign(guildInput), /exact controlled pool/);
    assert.equal(guildTest.calls.length, 0);
    assert.equal(guildTest.artifacts.size, 0);

    const botTest = harness();
    const botManifest = structuredClone(manifest());
    botManifest.trials = botManifest.trials.map((trial) => ({
      ...trial,
      expected_bot_id: foreignBotId,
    }));
    const botInput = input(botTest);
    botInput.manifest = botManifest;
    await assert.rejects(runBenchmarkCampaign(botInput), /exact controlled bot/);
    assert.equal(botTest.calls.length, 0);
    assert.equal(botTest.artifacts.size, 0);

    const distributionTest = harness();
    const distributionManifest = structuredClone(manifest());
    distributionManifest.trials[1].guild_id = CONTROLLED_GUILD_IDS[0];
    distributionManifest.guild_diversity.trials_per_guild = {
      [CONTROLLED_GUILD_IDS[0]]: 11,
      [CONTROLLED_GUILD_IDS[1]]: 9,
    };
    distributionManifest.reuse_policy.max_trials_per_guild = 11;
    const distributionInput = input(distributionTest);
    distributionInput.manifest = distributionManifest;
    await assert.rejects(runBenchmarkCampaign(distributionInput), /exactly 5 full and 5 forced/);
    assert.equal(distributionTest.calls.length, 0);
    assert.equal(distributionTest.artifacts.size, 0);
  });

  it('runs safety, restores every trial, and emits a derived passing report', async () => {
    const test = harness();
    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(report.summary.completed, 20);
    assert.equal(test.restores.length, 20);
    assert.equal(
      report.results.every((item) => item.baseline_restore_attempts === 1),
      true,
    );
    assert.deepEqual(test.states, ['safety', ...manifest().trials.map((trial) => trial.trial_id)]);
    assert.equal(test.artifacts.has('manifest.json'), true);
    assert.equal(test.artifacts.get('quota-preflight.json').results.length, 2);
    assert.equal(test.artifacts.has('safety-cases.json'), true);
    assert.equal(test.artifacts.has('report.json'), true);
    assert.deepEqual(
      test.calls.filter(
        ([kind, value]) =>
          kind === 'quota' ||
          kind === 'safety' ||
          value === 'quota-preflight.json' ||
          value === 'safety',
      ),
      [
        ['quota', CONTROLLED_GUILD_IDS[0]],
        ['quota', CONTROLLED_GUILD_IDS[1]],
        ['artifact', 'quota-preflight.json'],
        ['state', 'safety'],
        ['safety'],
      ],
    );
    assert.equal(JSON.stringify([...test.artifacts.values()]).includes('benchmark-token'), false);
  });

  it('quarantines before safety when a guild role-create window is unaffordable', async () => {
    const test = harness({ quotaUnavailableGuild: CONTROLLED_GUILD_IDS[0] });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError &&
        error.code === 'PREFLIGHT_ROLE_CREATE_UNAFFORDABLE',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'quota').length, 1);
    assert.equal(
      test.calls.some(([kind]) => kind === 'safety'),
      false,
    );
    assert.equal(
      test.calls.some(([kind]) => kind === 'trial'),
      false,
    );
    assert.equal(test.artifacts.get('quota-preflight.json').results[0].retry_after_ms, 172_207_050);
    assert.deepEqual(test.artifacts.get('quarantine.json'), {
      schema_version: 'discord-mcp.real-benchmark-quarantine.v1',
      run_id: 'campaign-test',
      commit: COMMIT,
      code: 'PREFLIGHT_ROLE_CREATE_UNAFFORDABLE',
      phase: 'quota_preflight',
      guild_id: CONTROLLED_GUILD_IDS[0],
      retry_after_ms: 172_207_050,
      baseline_restored: true,
      skipped_guild_ids: [CONTROLLED_GUILD_IDS[1]],
    });
    assert.equal(test.artifacts.has('report.json'), false);
  });

  it('classifies an exhausted affordable retry window as unavailable', async () => {
    const test = harness({
      quotaUnavailableGuild: CONTROLLED_GUILD_IDS[0],
      quotaUnavailableEvidence: {
        create_attempts: 2,
        waited_ms: 53_037,
        retry_after_ms: 53_037,
      },
    });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError &&
        error.code === 'PREFLIGHT_ROLE_CREATE_UNAVAILABLE',
    );
    assert.equal(test.artifacts.get('quarantine.json').code, 'PREFLIGHT_ROLE_CREATE_UNAVAILABLE');
    assert.equal(test.artifacts.get('quarantine.json').retry_after_ms, 53_037);
    assert.equal(test.artifacts.has('report.json'), false);
  });

  it('preserves the first guild evidence when the second guild is unavailable', async () => {
    const test = harness({ quotaUnavailableGuild: CONTROLLED_GUILD_IDS[1] });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError &&
        error.code === 'PREFLIGHT_ROLE_CREATE_UNAFFORDABLE',
    );
    assert.deepEqual(
      test.calls.filter(([kind]) => kind === 'quota'),
      CONTROLLED_GUILD_IDS.map((guildId) => ['quota', guildId]),
    );
    assert.deepEqual(
      test.artifacts.get('quota-preflight.json').results.map(({ guild_id, status }) => ({
        guild_id,
        status,
      })),
      [
        { guild_id: CONTROLLED_GUILD_IDS[0], status: 'ready' },
        { guild_id: CONTROLLED_GUILD_IDS[1], status: 'unavailable' },
      ],
    );
    assert.deepEqual(test.artifacts.get('quarantine.json').skipped_guild_ids, []);
    assert.equal(
      test.calls.some(([kind]) => kind === 'safety'),
      false,
    );
  });

  it('rejects quota evidence for another target before safety', async () => {
    const test = harness();
    const runQuotaPreflight = test.dependencies.runQuotaPreflight;
    test.dependencies.runQuotaPreflight = async (options) => ({
      ...(await runQuotaPreflight(options)),
      guild_id: CONTROLLED_GUILD_IDS[1],
    });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'PREFLIGHT_UNAVAILABLE',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'quota').length, 1);
    assert.equal(test.artifacts.get('quota-preflight.json').results[0].baseline_restored, false);
    assert.equal(
      test.calls.some(([kind]) => kind === 'safety'),
      false,
    );
  });

  it('fails closed with the known role when quota preflight cleanup is unverified', async () => {
    const test = harness({ quotaErrorGuild: CONTROLLED_GUILD_IDS[0] });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'PREFLIGHT_ROLE_DELETE_FAILED',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'quota').length, 1);
    assert.equal(
      test.calls.some(([kind]) => kind === 'safety'),
      false,
    );
    assert.equal(test.artifacts.get('quarantine.json').role_id, '777000777000778000');
    assert.equal(test.artifacts.get('quarantine.json').baseline_restored, false);
    assert.equal(test.artifacts.has('report.json'), false);
  });

  it('restores then quarantines immediately on a serious permission failure', async () => {
    const test = harness({ seriousAt: 'trial-03' });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'SERIOUS_PERMISSION_FAILURE',
    );
    assert.equal(test.restores.length, 3);
    assert.equal(test.calls.filter(([kind]) => kind === 'trial').length, 3);
    assert.equal(test.artifacts.get('quarantine.json').trial_id, 'trial-03');
    assert.equal(test.artifacts.has('report.json'), false);
  });

  it('fails fast at a restored trial boundary when the success threshold is unreachable', async () => {
    const test = harness({ failedAt: ['trial-01', 'trial-02'] });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'SUCCESS_THRESHOLD_UNREACHABLE',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'trial').length, 2);
    assert.equal(test.restores.length, 2);
    assert.equal(test.artifacts.has('results/trial-01.json'), true);
    assert.equal(test.artifacts.has('results/trial-02.json'), true);
    assert.equal(test.artifacts.has('report.json'), false);
    assert.deepEqual(test.artifacts.get('quarantine.json'), {
      schema_version: 'discord-mcp.real-benchmark-quarantine.v1',
      run_id: 'campaign-test',
      commit: COMMIT,
      code: 'SUCCESS_THRESHOLD_UNREACHABLE',
      phase: 'trial_boundary',
      trial_id: 'trial-02',
      guild_id: CONTROLLED_GUILD_IDS[1],
      passing_trials: 0,
      completed_trials: 2,
      remaining_trials: 18,
      required_passing_trials: 19,
      baseline_restored: true,
    });
  });

  it('keeps serious permission failure precedence over threshold fail-fast', async () => {
    const test = harness({ failedAt: ['trial-01'], seriousAt: 'trial-02' });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'SERIOUS_PERMISSION_FAILURE',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'trial').length, 2);
    assert.equal(test.artifacts.get('quarantine.json').code, 'SERIOUS_PERMISSION_FAILURE');
    assert.equal(test.artifacts.get('quarantine.json').phase, 'trial_oracle');
    assert.equal(test.artifacts.has('report.json'), false);
  });

  it('quarantines and stops when exact baseline restoration fails', async () => {
    const test = harness({ restoreFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_RESTORE_FAILED',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'trial').length, 1);
    assert.equal(test.restores.length, 6);
    assert.deepEqual(
      test.calls.filter(([kind]) => kind === 'sleep').map(([, milliseconds]) => milliseconds),
      [1_000, 2_000, 4_000, 8_000, 16_000],
    );
    assert.deepEqual(test.artifacts.get('quarantine.json'), {
      schema_version: 'discord-mcp.real-benchmark-quarantine.v1',
      run_id: 'campaign-test',
      commit: COMMIT,
      code: 'BASELINE_RESTORE_FAILED',
      phase: 'trial_cleanup',
      trial_id: 'trial-01',
      guild_id: CONTROLLED_GUILD_IDS[0],
      restore_attempts: 6,
      restore_failure_code: 'RESTORE_EXECUTION_AMBIGUOUS',
      readback_failure_code: 'RESTORE_UNCLASSIFIED',
    });
  });

  it('recovers a transient restore failure with bounded backoff and records the attempts', async () => {
    const test = harness({ restoreFailuresBeforeSuccess: 2 });

    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(test.restores.length, 22);
    assert.deepEqual(
      test.calls.filter(([kind]) => kind === 'sleep').map(([, milliseconds]) => milliseconds),
      [1_000, 2_000],
    );
    assert.equal(report.results[0].baseline_restore_attempts, 3);
    assert.deepEqual(
      test.restores.slice(0, 3).map((item) => item.retryProof !== null),
      [false, true, true],
    );
    assert.equal(
      report.results.slice(1).every((item) => item.baseline_restore_attempts === 1),
      true,
    );
  });

  it('retries preflight reads without authorizing missing cleanup resources or readback success', async () => {
    const test = harness({ preflightFailuresBeforeSuccess: 2 });

    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(report.results[0].baseline_restore_attempts, 3);
    assert.deepEqual(
      test.restores.slice(0, 3).map((item) => item.retryProof !== null),
      [false, false, false],
    );
    assert.deepEqual(
      test.calls.filter(([kind]) => kind === 'sleep').map(([, milliseconds]) => milliseconds),
      [1_000, 2_000],
    );
  });

  it('accepts an ambiguous cleanup response only after exact baseline readback succeeds', async () => {
    const test = harness({ ambiguousRestoreFailure: true });

    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(test.restores.length, 20);
    assert.equal(test.restores[0].retryProof, null);
  });

  it('never lets exact readback mask a deterministic restore safety violation', async () => {
    const test = harness({ deterministicRestoreFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_RESTORE_FAILED',
    );

    assert.equal(test.restores.length, 1);
    assert.equal(test.calls.filter(([kind]) => kind === 'sleep').length, 0);
    assert.equal(test.calls.filter(([kind]) => kind === 'verify').length, 5);
    assert.equal(
      test.artifacts.get('quarantine.json').restore_failure_code,
      'RESTORE_SAFETY_VIOLATION',
    );
    assert.equal(test.artifacts.get('quarantine.json').readback_failure_code, null);
  });

  it('never lets exact readback mask a deterministic execution rejection', async () => {
    const test = harness({ executionRejectedRestoreFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_RESTORE_FAILED',
    );

    assert.equal(test.restores.length, 1);
    assert.equal(test.calls.filter(([kind]) => kind === 'sleep').length, 0);
    assert.equal(test.calls.filter(([kind]) => kind === 'verify').length, 5);
    assert.equal(
      test.artifacts.get('quarantine.json').restore_failure_code,
      'RESTORE_EXECUTION_REJECTED',
    );
    assert.equal(test.artifacts.get('quarantine.json').readback_failure_code, null);
  });

  it('fails closed on an unclassified restore error', async () => {
    const test = harness({ unclassifiedRestoreFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_RESTORE_FAILED',
    );

    assert.equal(test.restores.length, 1);
    assert.equal(test.calls.filter(([kind]) => kind === 'sleep').length, 0);
    assert.equal(
      test.artifacts.get('quarantine.json').restore_failure_code,
      'RESTORE_UNCLASSIFIED',
    );
  });

  it('quarantines before safety when a controlled baseline is not exact', async () => {
    const test = harness({ baselineFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_PRECHECK_FAILED',
    );
    assert.equal(
      test.calls.some(([kind]) => kind === 'safety'),
      false,
    );
    assert.equal(test.artifacts.get('quarantine.json').phase, 'baseline_precheck');
  });

  it('rejects swapped guild and wrong-bot baselines before writing campaign artifacts', async () => {
    for (const mutate of [
      (value) => {
        const [first, second] = CONTROLLED_GUILD_IDS;
        [value.baselines[first], value.baselines[second]] = [
          value.baselines[second],
          value.baselines[first],
        ];
      },
      (value) => {
        value.baselines[CONTROLLED_GUILD_IDS[0]].bot_id = (
          BigInt(CONTROLLED_BOT_ID) + 1n
        ).toString();
      },
    ]) {
      const test = harness();
      const value = input(test);
      mutate(value);
      await assert.rejects(runBenchmarkCampaign(value), /baseline (guild|bot) mismatch/);
      assert.equal(test.artifacts.size, 0);
    }
  });

  it('quarantines when the baseline verifier reports another guild or bot', async () => {
    const test = harness();
    test.dependencies.verifyBaseline = async ({ baseline }) => ({
      verified: true,
      guild_id: (BigInt(baseline.guild_id) + 1n).toString(),
      bot_id: baseline.bot_id,
      fingerprint: baseline.fingerprint,
    });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_PRECHECK_FAILED',
    );
    assert.equal(test.artifacts.get('quarantine.json').phase, 'baseline_precheck');
  });
});
