#!/usr/bin/env node

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertActivationTrialArtifact } from './activation-artifact.mjs';
import { prepareArtifactStore } from './artifact-store.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import {
  CODEX_ACTIVATION_CONFIRMATION_PREFIX,
  CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  runCodexActivationTrial,
} from './codex-activation-trial.mjs';
import { assertSecretFreeJson } from './manifest.mjs';
import {
  ACTIVATION_BUNDLE_SCHEMA,
  ACTIVATION_VERIFIER_SCHEMA,
  verifyActivationTrialAggregate,
} from './verify-activation-trials.mjs';

export const CODEX_ACTIVATION_CAMPAIGN_SCHEMA = 'discord-mcp.codex-activation-campaign.v1';
export const CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION_CAMPAIGN:';

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const RUN_ID = /^[a-z][a-z0-9._-]{2,63}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const FLAGS = new Set([
  '--release',
  '--run-id',
  '--host-version',
  '--source-commit',
  '--guild',
  '--confirmation',
]);
const TRIAL_IDS = Object.freeze([
  'codex-activation-01',
  'codex-activation-02',
  'codex-activation-03',
]);

function expectedConfirmation({ release, runId, guildId }) {
  return `${CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${release}:${runId}:${guildId}`;
}

function validateCampaignRequest(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('activation campaign request is invalid');
  }
  if (!RELEASE.test(options.release ?? '') || !RELEASE.test(options.hostVersion ?? '')) {
    throw new TypeError('activation campaign request is invalid');
  }
  if (!RUN_ID.test(options.runId ?? '') || !COMMIT.test(options.sourceCommit ?? '')) {
    throw new TypeError('activation campaign request is invalid');
  }
  if (!CONTROLLED_GUILD_IDS.includes(options.guildId)) {
    throw new TypeError('activation campaign request is invalid');
  }
  if (options.confirmation !== expectedConfirmation(options)) {
    throw new TypeError('activation campaign confirmation is invalid');
  }
  if (typeof options.token !== 'string' || options.token.trim() === '') {
    throw new TypeError('activation campaign request is invalid');
  }
  if (typeof options.cwd !== 'string' || options.cwd.trim() === '') {
    throw new TypeError('activation campaign request is invalid');
  }
  if (typeof options.artifactRoot !== 'string' || !isAbsolute(options.artifactRoot)) {
    throw new TypeError('activation campaign request is invalid');
  }
  return {
    release: options.release,
    runId: options.runId,
    hostVersion: options.hostVersion,
    sourceCommit: options.sourceCommit,
    guildId: options.guildId,
    confirmation: options.confirmation,
    token: options.token.trim().startsWith('Bot ')
      ? options.token.trim().slice(4)
      : options.token.trim(),
    cwd: options.cwd,
    artifactRoot: options.artifactRoot,
  };
}

export function parseCodexActivationCampaignArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('activation campaign arguments are invalid');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS.has(flag) || Object.hasOwn(values, flag)) {
      throw new TypeError('activation campaign arguments are invalid');
    }
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new TypeError('activation campaign arguments are invalid');
    }
    values[flag] = value;
  }
  for (const flag of FLAGS) {
    if (!Object.hasOwn(values, flag)) {
      throw new TypeError('activation campaign arguments are invalid');
    }
  }
  const parsed = {
    release: values['--release'],
    runId: values['--run-id'],
    hostVersion: values['--host-version'],
    sourceCommit: values['--source-commit'],
    guildId: values['--guild'],
    confirmation: values['--confirmation'],
  };
  if (
    !RELEASE.test(parsed.release) ||
    !RELEASE.test(parsed.hostVersion) ||
    !RUN_ID.test(parsed.runId) ||
    !COMMIT.test(parsed.sourceCommit) ||
    !CONTROLLED_GUILD_IDS.includes(parsed.guildId) ||
    parsed.confirmation !== expectedConfirmation(parsed)
  ) {
    throw new TypeError('activation campaign arguments are invalid');
  }
  return parsed;
}

function campaignFailure(failedTrial = null, completedTrials = 0) {
  return {
    schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
    ok: false,
    completed_trials: completedTrials,
    ...(failedTrial === null ? {} : { failed_trial: failedTrial }),
  };
}

/** Run the fixed three-trial Codex gate and persist one public bundle exclusively. */
export async function runCodexActivationCampaign(options = {}, dependencies = {}) {
  const request = validateCampaignRequest(options);
  const runTrial = dependencies.runTrial ?? runCodexActivationTrial;
  const validateTrial = dependencies.validateTrial ?? assertActivationTrialArtifact;
  const verifyAggregate = dependencies.verifyAggregate ?? verifyActivationTrialAggregate;
  const prepareStore = dependencies.prepareStore ?? prepareArtifactStore;
  if (
    typeof runTrial !== 'function' ||
    typeof validateTrial !== 'function' ||
    typeof verifyAggregate !== 'function' ||
    typeof prepareStore !== 'function'
  ) {
    throw new TypeError('activation campaign dependencies are invalid');
  }
  if (
    runTrial === runCodexActivationTrial &&
    resolve(process.env.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT ?? '') !==
      resolve(request.artifactRoot)
  ) {
    throw new Error('activation campaign artifact root does not match the live adapter');
  }
  const store = await prepareStore({
    cwd: request.cwd,
    artifactRoot: request.artifactRoot,
    runId: request.runId,
  });
  if (typeof store?.writeArtifact !== 'function') {
    throw new Error('activation campaign artifact store is unavailable');
  }
  const artifacts = [];
  for (const trialId of TRIAL_IDS) {
    let result;
    try {
      result = await runTrial({
        release: request.release,
        runId: request.runId,
        trialId,
        hostVersion: request.hostVersion,
        sourceCommit: request.sourceCommit,
        target: {
          guildId: request.guildId,
          botId: CONTROLLED_BOT_ID,
          controlled: true,
          callerOwned: true,
        },
        operatorConfirmation: `${CODEX_ACTIVATION_CONFIRMATION_PREFIX}${request.release}:${trialId}`,
        writeApproval: `${CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${request.release}:${trialId}`,
        token: request.token,
        executionMode: 'live',
      });
      if (
        result === null ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).sort().join('\0') !== 'artifact\0ok'
      ) {
        throw new Error('activation trial result shape mismatch');
      }
      assertSecretFreeJson(result, 'activation_campaign_trial_result');
      validateTrial(result?.artifact);
      if (
        result.artifact.trial_id !== trialId ||
        result.artifact.host !== 'codex' ||
        result.artifact.host_version !== request.hostVersion ||
        result.artifact.release !== request.release ||
        result.artifact.source_commit !== request.sourceCommit ||
        result.artifact.execution_mode !== 'live'
      ) {
        throw new Error('activation trial identity mismatch');
      }
      if (
        typeof result.ok !== 'boolean' ||
        (result.ok ? result.artifact.result !== 'passed' : result.artifact.result !== 'failed')
      ) {
        throw new Error('activation trial result mismatch');
      }
      await store.writeArtifact(`results/${trialId}.json`, result.artifact);
    } catch {
      await store.writeArtifact(`results/${trialId}.failure.json`, {
        schema_version: 'discord-mcp.codex-activation-campaign-trial-failure.v1',
        trial_id: trialId,
        result: 'failed',
        error: 'activation trial did not produce a valid artifact',
      });
      throw new Error('activation trial failed before producing a valid artifact');
    }
    if (result?.ok !== true || result.artifact === undefined) {
      const failure = campaignFailure(result?.artifact ?? null, artifacts.length);
      assertSecretFreeJson(failure, 'activation_campaign_failure');
      return failure;
    }
    artifacts.push(result.artifact);
  }

  const bundle = { schema_version: ACTIVATION_BUNDLE_SCHEMA, trials: artifacts };
  assertSecretFreeJson(bundle, 'activation_campaign_bundle');
  const verification = verifyAggregate({
    trials: artifacts,
    expectedHosts: ['codex'],
    expectedRelease: request.release,
    expectedCommit: request.sourceCommit,
  });
  if (
    verification?.schema_version !== ACTIVATION_VERIFIER_SCHEMA ||
    verification.verified !== true
  ) {
    throw new Error('activation campaign public verification failed');
  }
  assertSecretFreeJson(verification, 'activation_campaign_public_verification');
  await store.writeArtifact('results/activation-trials-bundle.json', bundle);
  const result = {
    schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
    ok: true,
    bundle_relative_path: `runs/${request.runId}/results/activation-trials-bundle.json`,
    public_aggregate: verification,
  };
  assertSecretFreeJson(result, 'activation_campaign_result');
  return result;
}

function environmentToken(environment) {
  const value = environment.DISCORD_TESTBOT_B_TOKEN?.trim();
  if (!value) throw new Error('activation campaign environment is incomplete');
  return value.startsWith('Bot ') ? value.slice(4) : value;
}

function publicFailure() {
  return {
    schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
    ok: false,
    error: 'activation campaign failed',
  };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  runCampaign = runCodexActivationCampaign,
} = {}) {
  try {
    const parsed = parseCodexActivationCampaignArgs(argv);
    const artifactRoot = environment.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT;
    if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
      throw new Error('activation campaign environment is incomplete');
    }
    const token = environmentToken(environment);
    const result = await runCampaign({
      ...parsed,
      token,
      artifactRoot,
      cwd: resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
    });
    assertSecretFreeJson(result, 'activation_campaign_cli_result');
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok === true ? 0 : 1;
  } catch {
    stdout.write(`${JSON.stringify(publicFailure())}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
