import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  BenchmarkQuarantineError,
  CONTROLLED_BOT_ID,
  CONTROLLED_GUILD_IDS,
  createControlledReuseManifest,
  runBenchmarkCampaign,
} from './campaign.mjs';
import { createBenchmarkReport } from './manifest.mjs';

const COMMIT = 'babe8518767270733e5442643690cac13f94e473';
const FINGERPRINTS = Object.fromEntries(
  CONTROLLED_GUILD_IDS.map((guildId, index) => [guildId, `sha256:${String(index + 1).repeat(64)}`]),
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
      blocker_code: 'TARGET_GUILD_NOT_ALLOWED',
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

function harness({
  seriousAt = null,
  restoreFailure = false,
  ambiguousRestoreFailure = false,
  baselineFailure = false,
} = {}) {
  const artifacts = new Map();
  const states = [];
  const restores = [];
  const calls = [];
  return {
    artifacts,
    states,
    restores,
    calls,
    dependencies: {
      async verifyBaseline({ baseline }) {
        calls.push(['verify', baseline.guild_id]);
        if (baselineFailure) throw new Error('baseline drift');
        if (restoreFailure && restores.length > 0) throw new Error('restore drift');
        return {
          verified: true,
          guild_id: baseline.guild_id,
          bot_id: baseline.bot_id,
          fingerprint: baseline.fingerprint,
        };
      },
      async runSafetyCases() {
        calls.push(['safety']);
        return safetyCases();
      },
      async runTrial({ trial }) {
        calls.push(['trial', trial.trial_id]);
        return {
          result: result(
            trial,
            trial.trial_id === seriousAt ? [{ code: 'GENERATED_ROLE_DANGEROUS_PERMISSION' }] : [],
          ),
          cleanup: {
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
      async restoreBaseline({ baseline, cleanup }) {
        restores.push({ baseline, cleanup });
        if (restoreFailure || ambiguousRestoreFailure) throw new Error('ambiguous restore');
        return { restored: true, fingerprint: baseline.fingerprint };
      },
      createReport: createBenchmarkReport,
      async writeArtifact(path, value) {
        if (artifacts.has(path)) throw new Error('artifact overwrite');
        artifacts.set(path, structuredClone(value));
      },
      async createStateDirectory(name) {
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
        { guild_id: guildId, bot_id: CONTROLLED_BOT_ID, fingerprint: FINGERPRINTS[guildId] },
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

  it('runs safety, restores every trial, and emits a derived passing report', async () => {
    const test = harness();
    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(report.summary.completed, 20);
    assert.equal(test.restores.length, 20);
    assert.deepEqual(test.states, ['safety', ...manifest().trials.map((trial) => trial.trial_id)]);
    assert.equal(test.artifacts.has('manifest.json'), true);
    assert.equal(test.artifacts.has('safety-cases.json'), true);
    assert.equal(test.artifacts.has('report.json'), true);
    assert.equal(JSON.stringify([...test.artifacts.values()]).includes('benchmark-token'), false);
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

  it('quarantines and stops when exact baseline restoration fails', async () => {
    const test = harness({ restoreFailure: true });

    await assert.rejects(
      runBenchmarkCampaign(input(test)),
      (error) =>
        error instanceof BenchmarkQuarantineError && error.code === 'BASELINE_RESTORE_FAILED',
    );
    assert.equal(test.calls.filter(([kind]) => kind === 'trial').length, 1);
    assert.equal(test.artifacts.get('quarantine.json').phase, 'trial_cleanup');
  });

  it('accepts an ambiguous cleanup response only after exact baseline readback succeeds', async () => {
    const test = harness({ ambiguousRestoreFailure: true });

    const report = await runBenchmarkCampaign(input(test));

    assert.equal(report.summary.gate_passed, true);
    assert.equal(test.restores.length, 20);
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
