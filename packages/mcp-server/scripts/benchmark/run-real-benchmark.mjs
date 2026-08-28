#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireCampaignLock,
  baselineArtifactExists,
  prepareArtifactStore,
  readBaselineArtifact,
  recoverCampaignLock,
  recoverLegacyBaselineArtifact,
  writeBaselineArtifact,
} from './artifact-store.mjs';
import {
  initializeBenchmarkBaseline,
  restoreBenchmarkBaseline,
  verifyBenchmarkBaseline,
} from './baseline-lifecycle.mjs';
import { attestBuiltCli } from './build-attestation.mjs';
import {
  BenchmarkQuarantineError,
  CONTROLLED_BOT_ID,
  CONTROLLED_GUILD_IDS,
  createControlledReuseManifest,
  DEFAULT_BENCHMARK_REQUEST,
  runBenchmarkCampaign,
} from './campaign.mjs';
import { writeCampaignAttestation } from './campaign-attestation.mjs';
import { createDiscordRestClient, readDiscordSnapshot } from './discord-rest.mjs';
import { createBenchmarkReport, strictRfc3339Milliseconds } from './manifest.mjs';
import { probeGuildRoleCreateQuota } from './quota-preflight.mjs';
import { createTrialDependencies } from './runtime.mjs';
import { runBenchmarkSafetyCases } from './safety-cases.mjs';
import { snapshotFingerprint } from './snapshot-fingerprint.mjs';
import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';
import { runBenchmarkTrial } from './trial-runner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..', '..', '..');
const VALUE_FLAGS = new Set([
  '--expected-commit',
  '--artifact-root',
  '--guild',
  '--confirmation',
  '--not-before',
  '--run-id',
  '--request',
  '--inject-result-loss-trial',
  '--started-at',
  '--pid',
  '--hostname',
]);

const UNLOCK_FLAGS = new Set([
  '--expected-commit',
  '--run-id',
  '--started-at',
  '--confirmation',
  '--pid',
  '--hostname',
]);

function commandError(message) {
  throw new TypeError(`Invalid benchmark command: ${message}`);
}

function parseNotBefore(value) {
  const milliseconds = strictRfc3339Milliseconds(value);
  if (milliseconds === null) {
    throw new TypeError('--not-before must be a strict RFC3339 timestamp');
  }
  return milliseconds;
}

function parseOwnerPid(value) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError('--pid must be a positive safe integer');
  }
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError('--pid must be a positive safe integer');
  }
  return pid;
}

function parseOwnerHostname(value) {
  if (value.length < 1 || value.length > 255) {
    throw new TypeError('--hostname must contain 1 to 255 characters');
  }
  return value;
}

function parseTrialId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError('--inject-result-loss-trial must be a safe trial ID');
  }
  return value;
}

export function assertBenchmarkNotBefore(value, now = Date.now()) {
  const notBefore = parseNotBefore(value);
  if (!Number.isFinite(now)) throw new TypeError('benchmark clock must be finite');
  if (now < notBefore) {
    throw new Error(`benchmark not-before has not elapsed: ${value}`);
  }
  return notBefore;
}

export function parseBenchmarkCommand(argv) {
  if (!Array.isArray(argv) || !['initialize', 'migrate', 'run', 'unlock'].includes(argv[0])) {
    commandError('first argument must be initialize, migrate, run, or unlock');
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!VALUE_FLAGS.has(flag)) commandError(`unknown flag ${String(flag)}`);
    if (Object.hasOwn(values, flag)) commandError(`duplicate flag ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      commandError(`flag ${flag} requires a value`);
    }
    values[flag] = value;
    index += 1;
  }
  if (!Object.hasOwn(values, '--expected-commit')) commandError('missing --expected-commit');
  if (!/^[a-f0-9]{40}$/.test(values['--expected-commit'])) {
    commandError('--expected-commit must be a full lowercase Git SHA');
  }
  if (command !== 'unlock' && values['--started-at'] !== undefined) {
    commandError('--started-at is only valid for unlock');
  }
  if (command === 'unlock') {
    for (const flag of Object.keys(values)) {
      if (!UNLOCK_FLAGS.has(flag)) commandError(`${flag} is not valid for unlock`);
    }
    for (const required of ['--run-id', '--started-at', '--confirmation', '--pid', '--hostname']) {
      if (!Object.hasOwn(values, required)) commandError(`missing ${required}`);
    }
    parseNotBefore(values['--started-at']);
    parseOwnerPid(values['--pid']);
    parseOwnerHostname(values['--hostname']);
  } else if (!Object.hasOwn(values, '--artifact-root')) {
    commandError('missing --artifact-root');
  } else if (command === 'initialize') {
    for (const required of ['--guild', '--confirmation']) {
      if (!Object.hasOwn(values, required)) commandError(`missing ${required}`);
    }
    if (values['--request'] !== undefined || values['--not-before'] !== undefined) {
      commandError('--request and --not-before are only valid for run');
    }
    if (values['--pid'] !== undefined || values['--hostname'] !== undefined) {
      commandError('--pid and --hostname are only valid for unlock');
    }
    if (values['--inject-result-loss-trial'] !== undefined) {
      commandError('--inject-result-loss-trial is only valid for run');
    }
  } else if (command === 'migrate') {
    if (values['--guild'] === undefined) commandError('missing --guild');
    for (const flag of [
      '--confirmation',
      '--not-before',
      '--request',
      '--run-id',
      '--pid',
      '--hostname',
      '--inject-result-loss-trial',
    ]) {
      if (values[flag] !== undefined) commandError(`${flag} is not valid for migrate`);
    }
  } else if (values['--guild'] !== undefined || values['--confirmation'] !== undefined) {
    commandError('--guild and --confirmation are only valid for initialize');
  } else if (values['--pid'] !== undefined || values['--hostname'] !== undefined) {
    commandError('--pid and --hostname are only valid for unlock');
  } else if (values['--not-before'] === undefined) {
    commandError('missing --not-before');
  }
  if (command === 'run') parseNotBefore(values['--not-before']);
  return {
    command,
    expectedCommit: values['--expected-commit'],
    artifactRoot: values['--artifact-root'],
    guildId: values['--guild'],
    confirmation: values['--confirmation'],
    notBefore: values['--not-before'],
    runId: values['--run-id'],
    request: values['--request'],
    startedAt: values['--started-at'],
    pid: values['--pid'] === undefined ? undefined : parseOwnerPid(values['--pid']),
    hostname:
      values['--hostname'] === undefined ? undefined : parseOwnerHostname(values['--hostname']),
    injectResultLossTrial:
      values['--inject-result-loss-trial'] === undefined
        ? undefined
        : parseTrialId(values['--inject-result-loss-trial']),
  };
}

/**
 * Attach one explicit, benchmark-only response-loss fault to a trial. The
 * hook runs after the child MCP call has returned (so its checkpoint/mutation
 * already happened) and drops only the runner's result. It is never wired into
 * the production server.
 */
export function attachApplyResultLossInjection(trialDependencies, manifest, trialId) {
  if (trialId === undefined) return trialDependencies;
  if (trialDependencies === null || typeof trialDependencies !== 'object') {
    throw new TypeError('trial dependencies are required');
  }
  if (typeof trialDependencies.injectApplyResultLoss === 'function') {
    throw new Error('an apply-result-loss injector is already configured');
  }
  if (!manifest?.trials?.some((trial) => trial?.trial_id === trialId)) {
    throw new Error(`unknown benchmark trial for response-loss injection: ${trialId}`);
  }
  let injected = false;
  return {
    ...trialDependencies,
    async injectApplyResultLoss({ trial }) {
      if (injected || trial?.trial_id !== trialId) return;
      injected = true;
      throw Object.assign(new Error('RESULT_LOST_AFTER_MUTATION'), {
        code: 'RESULT_LOST_AFTER_MUTATION',
        source: 'mcp_tool_result',
        retriable: true,
      });
    },
  };
}

function benchmarkToken(environment) {
  const value = environment.DISCORD_TOKEN;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('DISCORD_TOKEN is required');
  }
  const trimmed = value.trim();
  return trimmed.startsWith('Bot ') ? trimmed.slice(4) : trimmed;
}

function generatedRunId(prefix, commit, now = Date.now()) {
  const timestamp = new Date(now)
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${prefix}-${timestamp}-${commit.slice(0, 8)}`;
}

async function initializeCommand(options, token, { runId } = {}) {
  if (!CONTROLLED_GUILD_IDS.includes(options.guildId)) {
    throw new Error('initializer guild is outside the controlled pool');
  }
  await assertBenchmarkSourceIntegrity({
    cwd: REPOSITORY_ROOT,
    expectedCommit: options.expectedCommit,
  });
  if (
    await baselineArtifactExists({
      cwd: REPOSITORY_ROOT,
      artifactRoot: options.artifactRoot,
      guildId: options.guildId,
    })
  ) {
    throw new Error('baseline artifact already exists');
  }
  const rest = createDiscordRestClient({ token });
  const readSnapshot = (input) => readDiscordSnapshot(rest, input);
  const baselineRunId =
    runId ?? options.runId ?? generatedRunId('baseline', options.expectedCommit);
  const baseline = await initializeBenchmarkBaseline({
    rest,
    readSnapshot,
    snapshotFingerprint,
    guildId: options.guildId,
    botId: CONTROLLED_BOT_ID,
    allowedGuildIds: CONTROLLED_GUILD_IDS,
    confirmation: options.confirmation,
    runId: baselineRunId,
  });
  const path = await writeBaselineArtifact({
    cwd: REPOSITORY_ROOT,
    artifactRoot: options.artifactRoot,
    baseline,
    integrityKey: token,
  });
  return {
    ok: true,
    command: 'initialize',
    guild_id: baseline.guild_id,
    bot_id: baseline.bot_id,
    fingerprint: baseline.fingerprint,
    artifact: path,
  };
}

async function migrateCommand(options, token) {
  if (!CONTROLLED_GUILD_IDS.includes(options.guildId)) {
    throw new Error('migration guild is outside the controlled pool');
  }
  await assertBenchmarkSourceIntegrity({
    cwd: REPOSITORY_ROOT,
    expectedCommit: options.expectedCommit,
  });
  const rest = createDiscordRestClient({ token });
  const result = await recoverLegacyBaselineArtifact({
    cwd: REPOSITORY_ROOT,
    artifactRoot: options.artifactRoot,
    guildId: options.guildId,
    integrityKey: token,
    verify: (baseline) => {
      if (baseline.bot_id !== CONTROLLED_BOT_ID) {
        throw new Error(`baseline bot mismatch for ${options.guildId}`);
      }
      return verifyBenchmarkBaseline({
        readSnapshot: (input) => readDiscordSnapshot(rest, input),
        snapshotFingerprint,
        baseline,
        integrityKey: token,
      });
    },
  });
  return {
    ok: true,
    command: 'migrate',
    guild_id: result.baseline.guild_id,
    bot_id: result.baseline.bot_id,
    fingerprint: result.baseline.fingerprint,
    artifact: result.path,
    legacy_backup: result.backupPath,
  };
}

async function runCommandWithLock(options, token, { runId, startedAt, request }) {
  const build = await attestBuiltCli({
    cwd: REPOSITORY_ROOT,
    expectedCommit: options.expectedCommit,
  });
  try {
    const baselines = Object.fromEntries(
      await Promise.all(
        CONTROLLED_GUILD_IDS.map(async (guildId) => {
          const baseline = await readBaselineArtifact({
            cwd: REPOSITORY_ROOT,
            artifactRoot: options.artifactRoot,
            guildId,
            integrityKey: token,
          });
          if (baseline.bot_id !== CONTROLLED_BOT_ID) {
            throw new Error(`baseline bot mismatch for ${guildId}`);
          }
          return [guildId, baseline];
        }),
      ),
    );
    const manifest = createControlledReuseManifest({
      runId,
      commit: options.expectedCommit,
      notBefore: options.notBefore,
      startedAt,
      request,
      builtCli: build.attestation,
    });
    const trialDependencies = attachApplyResultLossInjection(
      createTrialDependencies({ token }),
      manifest,
      options.injectResultLossTrial,
    );
    const store = await prepareArtifactStore({
      cwd: REPOSITORY_ROOT,
      artifactRoot: options.artifactRoot,
      runId,
    });
    const report = await runBenchmarkCampaign({
      manifest,
      baselines,
      request,
      cliPath: build.cliPath,
      cwd: REPOSITORY_ROOT,
      token,
      trialDependencies,
      dependencies: {
        verifyBaseline: ({ baseline }) =>
          verifyBenchmarkBaseline({
            readSnapshot: trialDependencies.readSnapshot,
            snapshotFingerprint,
            baseline,
            integrityKey: token,
          }),
        runQuotaPreflight: ({ baseline, guildId, botId, runId }) =>
          probeGuildRoleCreateQuota({
            rest: trialDependencies.rest,
            verifyBaseline: ({ baseline: targetBaseline }) =>
              verifyBenchmarkBaseline({
                readSnapshot: trialDependencies.readSnapshot,
                snapshotFingerprint,
                baseline: targetBaseline,
                integrityKey: token,
              }),
            baseline,
            guildId,
            botId,
            runId,
          }),
        runSafetyCases: runBenchmarkSafetyCases,
        runTrial: runBenchmarkTrial,
        restoreBaseline: ({ baseline, cleanup, reason, retryProof }) =>
          restoreBenchmarkBaseline({
            rest: trialDependencies.rest,
            readSnapshot: trialDependencies.readSnapshot,
            snapshotFingerprint,
            baseline,
            allowedGuildIds: CONTROLLED_GUILD_IDS,
            expectedBotId: CONTROLLED_BOT_ID,
            confirmation: `RESET_DISPOSABLE_GUILD:${baseline.guild_id}`,
            cleanup,
            reason,
            retryProof,
            integrityKey: token,
          }),
        createReport: createBenchmarkReport,
        writeArtifact: store.writeArtifact,
        createStateDirectory: store.createStateDirectory,
        async onProgress(event) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        },
      },
    });
    await publishCampaignAttestation({
      runDirectory: store.runDirectory,
      runId,
      commit: options.expectedCommit,
      integrityKey: token,
    });
    return {
      // `ok` preserves the activation/compatibility exit contract. The
      // stricter North Star claim is explicit in summary.verified_correctness_gate_passed.
      ok: report.summary.gate_passed,
      command: 'run',
      run_id: runId,
      artifact_directory: store.runDirectory,
      verified: report.summary.verified_correctness_gate_passed,
      summary: report.summary,
    };
  } finally {
    if (typeof build.cleanup === 'function') await build.cleanup();
  }
}

export async function publishCampaignAttestation(input, write = writeCampaignAttestation) {
  if (typeof write !== 'function') throw new TypeError('campaign attestation writer is required');
  return write(input);
}

export async function releaseCampaignLock(lock, primaryError) {
  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError === undefined) throw releaseError;
  }
}

export async function withCampaignLock({
  runId,
  startedAt,
  expectedCommit,
  task,
  acquireLock = acquireCampaignLock,
} = {}) {
  if (typeof task !== 'function') throw new TypeError('campaign lock task is required');
  const lock = await acquireLock({
    botId: CONTROLLED_BOT_ID,
    guildIds: CONTROLLED_GUILD_IDS,
    owner: {
      run_id: runId,
      commit: expectedCommit,
      started_at: startedAt,
    },
  });
  let primaryError;
  try {
    return await task();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await releaseCampaignLock(lock, primaryError);
  }
}

async function unlockCommand(options) {
  const result = await recoverCampaignLock({
    botId: CONTROLLED_BOT_ID,
    guildIds: CONTROLLED_GUILD_IDS,
    owner: {
      run_id: options.runId,
      commit: options.expectedCommit,
      started_at: options.startedAt,
      pid: options.pid,
      hostname: options.hostname,
    },
    confirmation: options.confirmation,
  });
  return {
    ok: true,
    command: 'unlock',
    lock_path: result.lockPath,
    quarantine_path: result.quarantinePath,
    owner: result.owner,
  };
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  {
    now = Date.now,
    acquireLock = acquireCampaignLock,
    initialize = initializeCommand,
    migrate = migrateCommand,
    run = runCommandWithLock,
    unlock = unlockCommand,
  } = {},
) {
  const options = parseBenchmarkCommand(argv);
  if (options.command === 'unlock') return unlock(options);
  const token = benchmarkToken(environment);

  const startedAtMilliseconds = now();
  if (options.command === 'run') assertBenchmarkNotBefore(options.notBefore, startedAtMilliseconds);
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  const runId =
    options.runId ??
    generatedRunId(
      options.command === 'run' ? 'real' : options.command,
      options.expectedCommit,
      startedAtMilliseconds,
    );
  return withCampaignLock({
    runId,
    startedAt,
    expectedCommit: options.expectedCommit,
    acquireLock,
    task: () => {
      if (options.command === 'initialize') return initialize(options, token, { runId });
      if (options.command === 'migrate') return migrate(options, token);
      return run(options, token, {
        runId,
        startedAt,
        request: options.request ?? DEFAULT_BENCHMARK_REQUEST,
      });
    },
  });
}

export function benchmarkProcessExitCode(result) {
  return result?.command === 'run' && result.ok === false ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      const code = benchmarkProcessExitCode(result);
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      const code =
        error instanceof BenchmarkQuarantineError ? error.code : 'BENCHMARK_COMMAND_FAILED';
      process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    });
}
