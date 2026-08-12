import { BenchmarkRestoreFailure } from './baseline-lifecycle.mjs';
import {
  assertBenchmarkManifest,
  BENCHMARK_SCHEMA,
  createBenchmarkReport,
  resultEvidencePass,
} from './manifest.mjs';
import { BenchmarkQuotaPreflightError, MAX_QUOTA_PREFLIGHT_WAIT_MS } from './quota-preflight.mjs';

export const CONTROLLED_GUILD_IDS = Object.freeze(['1533989004406558851', '1533998797863256165']);
export const CONTROLLED_BOT_ID = '1533457669384306858';
export const DEFAULT_BENCHMARK_REQUEST =
  'Build a professional gaming Discord community with LFG, voice rooms, events, safe onboarding, moderation, and polished welcome content.';
const RESTORE_RECOVERY_DELAYS_MS = Object.freeze([0, 1_000, 2_000, 4_000, 8_000, 16_000]);
const REQUIRED_PASSING_TRIALS = 19;
const QUOTA_PREFLIGHT_SCHEMA = 'discord-mcp.benchmark-quota-preflight.v1';
const QUOTA_PREFLIGHT_POOL_SCHEMA = 'discord-mcp.benchmark-quota-preflight-pool.v1';
const SNOWFLAKE = /^\d{17,20}$/;

const REQUIRED_CAMPAIGN_DEPENDENCIES = [
  'verifyBaseline',
  'runQuotaPreflight',
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recoveryFailureCode(error) {
  if (error === undefined || error === null) return null;
  if (error instanceof BenchmarkRestoreFailure) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  const baselineCode = message.match(/\bBASELINE_[A-Z0-9_]+\b/)?.[0];
  if (baselineCode) return baselineCode;
  const discord = message.match(/Discord REST (\d{3})(?: code (\d+))?/);
  if (discord) return `DISCORD_REST_${discord[1]}${discord[2] ? `_CODE_${discord[2]}` : ''}`;
  if (/allowlist|expected bot|confirmation/i.test(message)) return 'RESTORE_TARGET_GUARD';
  if (/response/i.test(message)) return 'RESTORE_RESPONSE_INVALID';
  return 'RESTORE_UNCLASSIFIED';
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
  profile = 'caller-owned-devbot',
} = {}) {
  const guildIds = CONTROLLED_GUILD_IDS;
  const botId = CONTROLLED_BOT_ID;
  requiredString(runId, 'runId');
  requiredString(commit, 'commit');
  requiredString(profile, 'profile');
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

function assertControlledManifestTargets(manifest) {
  const guildIds = new Set(manifest.trials.map((trial) => trial.guild_id));
  if (
    guildIds.size !== CONTROLLED_GUILD_IDS.length ||
    CONTROLLED_GUILD_IDS.some((guildId) => !guildIds.has(guildId))
  ) {
    throw new TypeError('manifest guilds must match the exact controlled pool');
  }
  if (manifest.trials.some((trial) => trial.expected_bot_id !== CONTROLLED_BOT_ID)) {
    throw new TypeError('manifest bot must match the exact controlled bot');
  }
  for (const guildId of CONTROLLED_GUILD_IDS) {
    const trials = manifest.trials.filter((trial) => trial.guild_id === guildId);
    if (
      trials.length !== 10 ||
      trials.filter((trial) => trial.mode === 'full').length !== 5 ||
      trials.filter((trial) => trial.mode === 'forced_resume').length !== 5
    ) {
      throw new TypeError('manifest must schedule exactly 5 full and 5 forced trials per guild');
    }
  }
}

function validateCampaignInput(input) {
  if (!record(input)) throw new TypeError('campaign input is required');
  const manifest = assertBenchmarkManifest(input.manifest);
  assertControlledManifestTargets(manifest);
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
  if (input.dependencies.sleep !== undefined && typeof input.dependencies.sleep !== 'function') {
    throw new TypeError('dependencies.sleep must be a function');
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

async function restoreWithRecovery(dependencies, manifest, trial, baseline, cleanup) {
  const sleep = dependencies.sleep ?? wait;
  let retryProof = null;
  let restoreFailure;
  let readbackFailure;
  for (let index = 0; index < RESTORE_RECOVERY_DELAYS_MS.length; index += 1) {
    const delay = RESTORE_RECOVERY_DELAYS_MS[index];
    if (delay > 0) {
      await progress(dependencies, {
        phase: 'trial_cleanup',
        status: 'retrying',
        trial_id: trial.trial_id,
        attempt: index + 1,
        delay_ms: delay,
        restore_failure_code: recoveryFailureCode(restoreFailure),
        readback_failure_code: recoveryFailureCode(readbackFailure),
      });
      await sleep(delay);
    }
    let readbackMayConfirm = false;
    try {
      const restored = await dependencies.restoreBaseline({
        baseline,
        cleanup,
        reason: `discord-mcp benchmark restore ${manifest.run_id} ${trial.trial_id}`,
        retryProof,
      });
      restoreFailure = undefined;
      retryProof = restored?.retryProof ?? retryProof;
      readbackMayConfirm = true;
    } catch (error) {
      restoreFailure = error;
      if (!(error instanceof BenchmarkRestoreFailure) || error.retryable !== true) {
        return {
          after: null,
          attempts: index + 1,
          restoreFailureCode: recoveryFailureCode(error),
          readbackFailureCode: null,
        };
      }
      if (error.preflightVerified && error.retryProof !== null) retryProof = error.retryProof;
      readbackMayConfirm = error.readbackMayConfirm;
    }
    if (readbackMayConfirm) {
      try {
        const after = await verifyBaseline(
          dependencies,
          baseline,
          trial.guild_id,
          trial.expected_bot_id,
        );
        return { after, attempts: index + 1 };
      } catch (error) {
        readbackFailure = error;
      }
    } else {
      readbackFailure = undefined;
    }
  }
  return {
    after: null,
    attempts: RESTORE_RECOVERY_DELAYS_MS.length,
    restoreFailureCode: recoveryFailureCode(restoreFailure),
    readbackFailureCode: recoveryFailureCode(readbackFailure),
  };
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

function normalizeQuotaPreflightEvidence(
  value,
  baseline,
  guildId,
  botId,
  allowErrorStatus = false,
) {
  if (!record(value) || value.schema_version !== QUOTA_PREFLIGHT_SCHEMA) {
    throw new TypeError('quota preflight evidence schema is invalid');
  }
  if (value.guild_id !== guildId || value.bot_id !== botId) {
    throw new TypeError('quota preflight evidence target mismatch');
  }
  const validStatus =
    value.status === 'ready' ||
    value.status === 'unavailable' ||
    (allowErrorStatus && value.status === null);
  if (!validStatus) throw new TypeError('quota preflight evidence status is invalid');
  if (
    !Number.isSafeInteger(value.create_attempts) ||
    value.create_attempts < 0 ||
    value.create_attempts > 2 ||
    !Number.isSafeInteger(value.waited_ms) ||
    value.waited_ms < 0 ||
    (value.retry_after_ms !== null &&
      (!Number.isSafeInteger(value.retry_after_ms) || value.retry_after_ms < 0)) ||
    (value.role_id !== null &&
      (typeof value.role_id !== 'string' || !SNOWFLAKE.test(value.role_id))) ||
    value.baseline_fingerprint_before !== baseline.fingerprint ||
    (value.baseline_fingerprint_after !== null &&
      value.baseline_fingerprint_after !== baseline.fingerprint) ||
    typeof value.baseline_restored !== 'boolean' ||
    value.baseline_restored !== (value.baseline_fingerprint_after === baseline.fingerprint)
  ) {
    throw new TypeError('quota preflight evidence fields are invalid');
  }
  if (
    (value.status !== null && value.create_attempts === 0) ||
    (value.status === 'ready' && value.role_id === null) ||
    (value.status === 'unavailable' && value.role_id !== null) ||
    (value.status !== null &&
      (value.baseline_restored !== true ||
        value.baseline_fingerprint_after !== baseline.fingerprint))
  ) {
    throw new TypeError('quota preflight evidence does not prove its status');
  }
  return {
    schema_version: QUOTA_PREFLIGHT_SCHEMA,
    guild_id: guildId,
    bot_id: botId,
    status: value.status,
    create_attempts: value.create_attempts,
    waited_ms: value.waited_ms,
    retry_after_ms: value.retry_after_ms,
    role_id: value.role_id,
    baseline_fingerprint_before: value.baseline_fingerprint_before,
    baseline_fingerprint_after: value.baseline_fingerprint_after,
    baseline_restored: value.baseline_restored,
  };
}

function quotaPreflightArtifact(results) {
  return {
    schema_version: QUOTA_PREFLIGHT_POOL_SCHEMA,
    results,
  };
}

async function runPoolQuotaPreflight(dependencies, manifest, baselines, guildIds) {
  const results = [];
  for (const [index, guildId] of guildIds.entries()) {
    const botId = expectedBotForGuild(manifest, guildId);
    const baseline = baselines[guildId];
    await progress(dependencies, {
      phase: 'quota_preflight',
      status: 'started',
      guild_id: guildId,
    });
    let result;
    try {
      result = normalizeQuotaPreflightEvidence(
        await dependencies.runQuotaPreflight({
          baseline,
          guildId,
          botId,
          runId: manifest.run_id,
        }),
        baseline,
        guildId,
        botId,
      );
    } catch (error) {
      const code =
        error instanceof BenchmarkQuotaPreflightError &&
        typeof error.code === 'string' &&
        /^PREFLIGHT_[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : 'PREFLIGHT_UNAVAILABLE';
      let failureEvidence;
      try {
        failureEvidence = normalizeQuotaPreflightEvidence(
          error instanceof BenchmarkQuotaPreflightError ? error.evidence : {},
          baseline,
          guildId,
          botId,
          true,
        );
      } catch {
        failureEvidence = {
          schema_version: QUOTA_PREFLIGHT_SCHEMA,
          guild_id: guildId,
          bot_id: botId,
          status: null,
          create_attempts: 0,
          waited_ms: 0,
          retry_after_ms: null,
          role_id: null,
          baseline_fingerprint_before: baseline.fingerprint,
          baseline_fingerprint_after: null,
          baseline_restored: false,
        };
      }
      results.push(failureEvidence);
      await dependencies.writeArtifact('quota-preflight.json', quotaPreflightArtifact(results));
      await quarantine(dependencies, manifest, {
        code,
        phase: 'quota_preflight',
        guild_id: guildId,
        retry_after_ms: failureEvidence.retry_after_ms,
        role_id: failureEvidence.role_id,
        baseline_restored: failureEvidence.baseline_restored,
        skipped_guild_ids: guildIds.slice(index + 1),
      });
      throw new BenchmarkQuarantineError(code);
    }
    results.push(result);
    if (result.status !== 'ready') {
      const code =
        result.retry_after_ms !== null && result.retry_after_ms > MAX_QUOTA_PREFLIGHT_WAIT_MS
          ? 'PREFLIGHT_ROLE_CREATE_UNAFFORDABLE'
          : 'PREFLIGHT_ROLE_CREATE_UNAVAILABLE';
      await dependencies.writeArtifact('quota-preflight.json', quotaPreflightArtifact(results));
      await quarantine(dependencies, manifest, {
        code,
        phase: 'quota_preflight',
        guild_id: guildId,
        retry_after_ms: result.retry_after_ms,
        baseline_restored: true,
        skipped_guild_ids: guildIds.slice(index + 1),
      });
      throw new BenchmarkQuarantineError(code);
    }
    await progress(dependencies, {
      phase: 'quota_preflight',
      status: 'passed',
      guild_id: guildId,
      create_attempts: result.create_attempts,
      waited_ms: result.waited_ms,
    });
  }
  await dependencies.writeArtifact('quota-preflight.json', quotaPreflightArtifact(results));
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
  await runPoolQuotaPreflight(dependencies, manifest, input.baselines, guildIds);

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
    let baselineRestoreAttempts = 0;
    if (cleanupHasTargets(outcome.cleanup)) {
      const recovery = await restoreWithRecovery(
        dependencies,
        manifest,
        trial,
        baseline,
        outcome.cleanup,
      );
      after = recovery.after;
      baselineRestoreAttempts = recovery.attempts;
      if (after === null) {
        await quarantine(dependencies, manifest, {
          code: 'BASELINE_RESTORE_FAILED',
          phase: 'trial_cleanup',
          trial_id: trial.trial_id,
          guild_id: trial.guild_id,
          restore_attempts: recovery.attempts,
          restore_failure_code: recovery.restoreFailureCode,
          readback_failure_code: recovery.readbackFailureCode,
        });
        throw new BenchmarkQuarantineError('BASELINE_RESTORE_FAILED');
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
      baseline_restore_attempts: baselineRestoreAttempts,
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

    const completedTrials = results.length;
    const passingTrials = results.filter(resultEvidencePass).length;
    const remainingTrials = manifest.trials.length - completedTrials;
    if (passingTrials + remainingTrials < REQUIRED_PASSING_TRIALS) {
      await quarantine(dependencies, manifest, {
        code: 'SUCCESS_THRESHOLD_UNREACHABLE',
        phase: 'trial_boundary',
        trial_id: trial.trial_id,
        guild_id: trial.guild_id,
        passing_trials: passingTrials,
        completed_trials: completedTrials,
        remaining_trials: remainingTrials,
        required_passing_trials: REQUIRED_PASSING_TRIALS,
        baseline_restored: true,
      });
      throw new BenchmarkQuarantineError('SUCCESS_THRESHOLD_UNREACHABLE');
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
