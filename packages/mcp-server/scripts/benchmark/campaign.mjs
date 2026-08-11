import { assertBenchmarkManifest, BENCHMARK_SCHEMA, createBenchmarkReport } from './manifest.mjs';

export const CONTROLLED_GUILD_IDS = Object.freeze(['1533989004406558851', '1533998797863256165']);
export const CONTROLLED_BOT_ID = '1533457669384306858';
export const DEFAULT_BENCHMARK_REQUEST =
  'Build a professional gaming Discord community with LFG, voice rooms, events, safe onboarding, moderation, and polished welcome content.';

const REQUIRED_CAMPAIGN_DEPENDENCIES = [
  'verifyBaseline',
  'runSafetyCases',
  'runTrial',
  'restoreBaseline',
  'createReport',
  'writeArtifact',
  'createStateDirectory',
];

export class BenchmarkQuarantineError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BenchmarkQuarantineError';
    this.code = code;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
  return value;
}

function nextSnowflake(value) {
  return (BigInt(value) + 1n).toString();
}

function expectedBotForGuild(manifest, guildId) {
  const botIds = new Set(
    manifest.trials
      .filter((trial) => trial.guild_id === guildId)
      .map((trial) => trial.expected_bot_id),
  );
  if (botIds.size !== 1) throw new TypeError(`manifest bot binding is ambiguous for ${guildId}`);
  return [...botIds][0];
}

export function createControlledReuseManifest({
  runId,
  commit,
  builtCli,
  guildIds = CONTROLLED_GUILD_IDS,
  botId = CONTROLLED_BOT_ID,
  profile = 'caller-owned-devbot',
} = {}) {
  requiredString(runId, 'runId');
  requiredString(commit, 'commit');
  requiredString(botId, 'botId');
  requiredString(profile, 'profile');
  if (!Array.isArray(guildIds) || guildIds.length !== 2 || new Set(guildIds).size !== 2) {
    throw new TypeError('guildIds must contain exactly two unique controlled guilds');
  }
  const trials = Array.from({ length: 20 }, (_, index) => ({
    trial_id: `trial-${String(index + 1).padStart(2, '0')}`,
    mode: index < 10 ? 'full' : 'forced_resume',
    guild_id: guildIds[index % guildIds.length],
    expected_bot_id: botId,
    profile,
  }));
  const manifest = {
    schema_version: BENCHMARK_SCHEMA,
    run_id: runId,
    commit,
    built_cli: structuredClone(builtCli),
    api_version: '10',
    reuse_policy: {
      strategy: 'controlled_reuse',
      max_trials_per_guild: 10,
      rationale:
        'Two dedicated disposable guilds are restored to independently fingerprinted baselines between every eligible trial.',
    },
    guild_diversity: {
      total_trial_count: 20,
      unique_guild_count: 2,
      trials_per_guild: Object.fromEntries(guildIds.map((guildId) => [guildId, 10])),
    },
    trials,
  };
  return assertBenchmarkManifest(manifest);
}

function validateCampaignInput(input) {
  if (!record(input)) throw new TypeError('campaign input is required');
  const manifest = assertBenchmarkManifest(input.manifest);
  for (const name of ['request', 'cliPath', 'cwd', 'token']) requiredString(input[name], name);
  if (!record(input.baselines)) throw new TypeError('baselines are required');
  for (const guildId of new Set(manifest.trials.map((trial) => trial.guild_id))) {
    const baseline = input.baselines[guildId];
    if (!record(baseline)) throw new TypeError(`baseline is missing for ${guildId}`);
    if (baseline.guild_id !== guildId)
      throw new TypeError(`baseline guild mismatch for ${guildId}`);
    if (baseline.bot_id !== expectedBotForGuild(manifest, guildId)) {
      throw new TypeError(`baseline bot mismatch for ${guildId}`);
    }
  }
  if (!record(input.trialDependencies)) throw new TypeError('trialDependencies are required');
  if (!record(input.dependencies)) throw new TypeError('campaign dependencies are required');
  for (const name of REQUIRED_CAMPAIGN_DEPENDENCIES) {
    if (typeof input.dependencies[name] !== 'function') {
      throw new TypeError(`dependencies.${name} must be a function`);
    }
  }
  return manifest;
}

function cleanupHasTargets(cleanup) {
  if (!record(cleanup?.bindings)) return false;
  return Object.values(cleanup.bindings).some(
    (binding) => record(binding) && Object.keys(binding).length > 0,
  );
}

function failedTrialResult(trial) {
  return {
    trial_id: trial.trial_id,
    mode: trial.mode,
    guild_id: trial.guild_id,
    eligible: true,
    terminal_status: 'error',
    oracle_match: false,
    snapshot_oracle_pass: false,
    blueprint_oracle_match: false,
    audit_oracle_pass: false,
    serious_permission_failures: [],
    functional_failures: [{ code: 'TRIAL_RUNNER_UNAVAILABLE' }],
    plan_snapshot_unchanged: false,
    forced_resume_observed: trial.mode === 'forced_resume' ? false : null,
    operations_planned: 0,
    apply_calls: 0,
    restart_count: 0,
    replay_status: null,
    evidence_status: null,
    audit_entry_count: 0,
    audit_trail_complete: false,
    verified_counts: null,
  };
}

async function quarantine(dependencies, manifest, details) {
  const artifact = {
    schema_version: 'discord-mcp.real-benchmark-quarantine.v1',
    run_id: manifest.run_id,
    commit: manifest.commit,
    ...details,
  };
  await dependencies.writeArtifact('quarantine.json', artifact);
}

async function verifyBaseline(dependencies, baseline, expectedGuildId, expectedBotId) {
  const result = await dependencies.verifyBaseline({ baseline });
  if (
    result?.verified !== true ||
    result.fingerprint !== baseline.fingerprint ||
    result.guild_id !== expectedGuildId ||
    result.bot_id !== expectedBotId
  ) {
    throw new Error('BASELINE_VERIFICATION_INVALID');
  }
  return result;
}

async function progress(dependencies, event) {
  if (typeof dependencies.onProgress === 'function') await dependencies.onProgress(event);
}

async function verifyPoolOrQuarantine(dependencies, manifest, baselines, guildIds, phase) {
  try {
    for (const guildId of guildIds) {
      await verifyBaseline(
        dependencies,
        baselines[guildId],
        guildId,
        expectedBotForGuild(manifest, guildId),
      );
    }
  } catch {
    await quarantine(dependencies, manifest, { code: 'BASELINE_PRECHECK_FAILED', phase });
    throw new BenchmarkQuarantineError('BASELINE_PRECHECK_FAILED');
  }
}

export async function runBenchmarkCampaign(input) {
  const manifest = validateCampaignInput(input);
  const { dependencies } = input;
  await dependencies.writeArtifact('manifest.json', manifest);

  const guildIds = [...new Set(manifest.trials.map((trial) => trial.guild_id))];
  await verifyPoolOrQuarantine(
    dependencies,
    manifest,
    input.baselines,
    guildIds,
    'baseline_precheck',
  );

  const safetyStateDirectory = await dependencies.createStateDirectory('safety');
  await progress(dependencies, { phase: 'safety', status: 'started' });
  let safetyCases;
  try {
    safetyCases = await dependencies.runSafetyCases({
      guardGuildId: guildIds[0],
      wrongGuildId: guildIds[1],
      guardMessageChannelId: input.baselines[guildIds[0]].canary.channel_id,
      wrongGuildMessageChannelId: input.baselines[guildIds[1]].canary.channel_id,
      activeBotId: manifest.trials[0].expected_bot_id,
      wrongBotId: nextSnowflake(manifest.trials[0].expected_bot_id),
      request: input.request,
      cliPath: input.cliPath,
      cwd: input.cwd,
      token: input.token,
      stateDirectory: safetyStateDirectory,
      dependencies: input.trialDependencies,
    });
  } catch {
    await quarantine(dependencies, manifest, { code: 'SAFETY_CASE_UNAVAILABLE', phase: 'safety' });
    throw new BenchmarkQuarantineError('SAFETY_CASE_UNAVAILABLE');
  }
  await dependencies.writeArtifact('safety-cases.json', safetyCases);
  if (
    !Array.isArray(safetyCases) ||
    safetyCases.length !== 3 ||
    safetyCases.some((item) => !item.passed)
  ) {
    await quarantine(dependencies, manifest, { code: 'SAFETY_CASE_FAILED', phase: 'safety' });
    throw new BenchmarkQuarantineError('SAFETY_CASE_FAILED');
  }
  await progress(dependencies, { phase: 'safety', status: 'passed' });
  await verifyPoolOrQuarantine(
    dependencies,
    manifest,
    input.baselines,
    guildIds,
    'post_safety_baseline',
  );

  const results = [];
  for (const trial of manifest.trials) {
    await progress(dependencies, {
      phase: 'trial',
      status: 'started',
      trial_id: trial.trial_id,
      mode: trial.mode,
      guild_id: trial.guild_id,
    });
    const baseline = input.baselines[trial.guild_id];
    const before = await verifyBaseline(
      dependencies,
      baseline,
      trial.guild_id,
      trial.expected_bot_id,
    );
    const stateDirectory = await dependencies.createStateDirectory(trial.trial_id);
    let outcome;
    try {
      outcome = await dependencies.runTrial({
        trial,
        request: input.request,
        cliPath: input.cliPath,
        cwd: input.cwd,
        token: input.token,
        baselineMessageChannelId: baseline.canary.channel_id,
        stateDirectory,
        dependencies: input.trialDependencies,
      });
    } catch {
      outcome = { result: failedTrialResult(trial), cleanup: null };
    }

    let after;
    if (cleanupHasTargets(outcome.cleanup)) {
      try {
        await dependencies.restoreBaseline({
          baseline,
          cleanup: outcome.cleanup,
          reason: `discord-mcp benchmark restore ${manifest.run_id} ${trial.trial_id}`,
        });
      } catch {
        try {
          after = await verifyBaseline(
            dependencies,
            baseline,
            trial.guild_id,
            trial.expected_bot_id,
          );
        } catch {
          await quarantine(dependencies, manifest, {
            code: 'BASELINE_RESTORE_FAILED',
            phase: 'trial_cleanup',
            trial_id: trial.trial_id,
            guild_id: trial.guild_id,
          });
          throw new BenchmarkQuarantineError('BASELINE_RESTORE_FAILED');
        }
      }
    }
    try {
      after ??= await verifyBaseline(dependencies, baseline, trial.guild_id, trial.expected_bot_id);
    } catch {
      await quarantine(dependencies, manifest, {
        code: 'BASELINE_RESTORE_FAILED',
        phase: 'trial_cleanup',
        trial_id: trial.trial_id,
        guild_id: trial.guild_id,
      });
      throw new BenchmarkQuarantineError('BASELINE_RESTORE_FAILED');
    }

    const result = {
      ...outcome.result,
      baseline_verified_before: before.verified,
      baseline_restored_after: after.verified,
      baseline_fingerprint_before: before.fingerprint,
      baseline_fingerprint_after: after.fingerprint,
    };
    await dependencies.writeArtifact(`results/${trial.trial_id}.json`, result);
    results.push(result);
    await progress(dependencies, {
      phase: 'trial',
      status: 'restored',
      trial_id: trial.trial_id,
      terminal_status: result.terminal_status,
      oracle_match: result.oracle_match,
    });

    if (result.serious_permission_failures.length > 0) {
      await quarantine(dependencies, manifest, {
        code: 'SERIOUS_PERMISSION_FAILURE',
        phase: 'trial_oracle',
        trial_id: trial.trial_id,
        guild_id: trial.guild_id,
      });
      throw new BenchmarkQuarantineError('SERIOUS_PERMISSION_FAILURE');
    }
  }

  const report = dependencies.createReport(manifest, results, safetyCases);
  await dependencies.writeArtifact('report.json', report);
  await progress(dependencies, { phase: 'campaign', status: 'complete', summary: report.summary });
  return report;
}

export function campaignDependencies(overrides = {}) {
  return {
    createReport: createBenchmarkReport,
    ...overrides,
  };
}
