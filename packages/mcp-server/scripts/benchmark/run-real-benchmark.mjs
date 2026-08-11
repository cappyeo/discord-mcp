#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  baselineArtifactExists,
  prepareArtifactStore,
  readBaselineArtifact,
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
import { createDiscordRestClient, readDiscordSnapshot } from './discord-rest.mjs';
import { createBenchmarkReport } from './manifest.mjs';
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
  '--run-id',
  '--request',
]);

function commandError(message) {
  throw new TypeError(`Invalid benchmark command: ${message}`);
}

export function parseBenchmarkCommand(argv) {
  if (!Array.isArray(argv) || !['initialize', 'run'].includes(argv[0])) {
    commandError('first argument must be initialize or run');
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
  for (const required of ['--expected-commit', '--artifact-root']) {
    if (!Object.hasOwn(values, required)) commandError(`missing ${required}`);
  }
  if (!/^[a-f0-9]{40}$/.test(values['--expected-commit'])) {
    commandError('--expected-commit must be a full lowercase Git SHA');
  }
  if (command === 'initialize') {
    for (const required of ['--guild', '--confirmation']) {
      if (!Object.hasOwn(values, required)) commandError(`missing ${required}`);
    }
    if (values['--request'] !== undefined) commandError('--request is only valid for run');
  } else if (values['--guild'] !== undefined || values['--confirmation'] !== undefined) {
    commandError('--guild and --confirmation are only valid for initialize');
  }
  return {
    command,
    expectedCommit: values['--expected-commit'],
    artifactRoot: values['--artifact-root'],
    guildId: values['--guild'],
    confirmation: values['--confirmation'],
    runId: values['--run-id'],
    request: values['--request'],
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

function generatedRunId(prefix, commit) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${prefix}-${timestamp}-${commit.slice(0, 8)}`;
}

async function initializeCommand(options, token) {
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
  const runId = options.runId ?? generatedRunId('baseline', options.expectedCommit);
  const baseline = await initializeBenchmarkBaseline({
    rest,
    readSnapshot,
    snapshotFingerprint,
    guildId: options.guildId,
    botId: CONTROLLED_BOT_ID,
    allowedGuildIds: CONTROLLED_GUILD_IDS,
    confirmation: options.confirmation,
    runId,
  });
  const path = await writeBaselineArtifact({
    cwd: REPOSITORY_ROOT,
    artifactRoot: options.artifactRoot,
    baseline,
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

async function runCommand(options, token) {
  const build = await attestBuiltCli({
    cwd: REPOSITORY_ROOT,
    expectedCommit: options.expectedCommit,
  });
  const baselines = Object.fromEntries(
    await Promise.all(
      CONTROLLED_GUILD_IDS.map(async (guildId) => {
        const baseline = await readBaselineArtifact({
          cwd: REPOSITORY_ROOT,
          artifactRoot: options.artifactRoot,
          guildId,
        });
        if (baseline.bot_id !== CONTROLLED_BOT_ID) {
          throw new Error(`baseline bot mismatch for ${guildId}`);
        }
        return [guildId, baseline];
      }),
    ),
  );
  const runId = options.runId ?? generatedRunId('real', options.expectedCommit);
  const store = await prepareArtifactStore({
    cwd: REPOSITORY_ROOT,
    artifactRoot: options.artifactRoot,
    runId,
  });
  const trialDependencies = createTrialDependencies({ token });
  const manifest = createControlledReuseManifest({
    runId,
    commit: options.expectedCommit,
    builtCli: build.attestation,
  });
  const report = await runBenchmarkCampaign({
    manifest,
    baselines,
    request: options.request ?? DEFAULT_BENCHMARK_REQUEST,
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
        }),
      runSafetyCases: runBenchmarkSafetyCases,
      runTrial: runBenchmarkTrial,
      restoreBaseline: ({ baseline, cleanup, reason }) =>
        restoreBenchmarkBaseline({
          rest: trialDependencies.rest,
          readSnapshot: trialDependencies.readSnapshot,
          snapshotFingerprint,
          baseline,
          cleanup,
          reason,
        }),
      createReport: createBenchmarkReport,
      writeArtifact: store.writeArtifact,
      createStateDirectory: store.createStateDirectory,
      async onProgress(event) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
    },
  });
  return {
    ok: report.summary.gate_passed,
    command: 'run',
    run_id: runId,
    artifact_directory: store.runDirectory,
    summary: report.summary,
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseBenchmarkCommand(argv);
  const token = benchmarkToken(environment);
  return options.command === 'initialize'
    ? initializeCommand(options, token)
    : runCommand(options, token);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code =
        error instanceof BenchmarkQuarantineError ? error.code : 'BENCHMARK_COMMAND_FAILED';
      process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    });
}
