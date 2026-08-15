import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertActivationTrialArtifact } from './activation-artifact.mjs';
import { prepareArtifactStore } from './artifact-store.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { assertSecretFreeJson } from './manifest.mjs';
import {
  ACTIVATION_BUNDLE_SCHEMA,
  ACTIVATION_VERIFIER_SCHEMA,
  verifyActivationTrialAggregate,
} from './verify-activation-trials.mjs';

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const RUN_ID = /^[a-z][a-z0-9._-]{2,63}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HOST = /^[a-z][a-z0-9._-]{1,31}$/;
const SCHEMA = /^[a-z][a-z0-9._-]{2,127}\.v\d+$/;
const CONFIRMATION_PREFIX = /^APPROVE_[A-Z0-9_]+:$/;
const FLAGS = new Set([
  '--release',
  '--run-id',
  '--host-version',
  '--source-commit',
  '--guild',
  '--confirmation',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertContract(value) {
  if (!record(value)) throw new TypeError('activation campaign contract is invalid');
  if (!HOST.test(value.host ?? '') || !SCHEMA.test(value.campaignSchema ?? ''))
    throw new TypeError('activation campaign contract is invalid');
  if (!SCHEMA.test(value.trialFailureSchema ?? ''))
    throw new TypeError('activation campaign contract is invalid');
  for (const prefix of [
    value.campaignConfirmationPrefix,
    value.trialConfirmationPrefix,
    value.writeConfirmationPrefix,
  ]) {
    if (typeof prefix !== 'string' || !CONFIRMATION_PREFIX.test(prefix))
      throw new TypeError('activation campaign contract is invalid');
  }
  if (
    !Array.isArray(value.trialIds) ||
    value.trialIds.length !== 3 ||
    new Set(value.trialIds).size !== value.trialIds.length ||
    value.trialIds.some((trialId) => !RUN_ID.test(trialId)) ||
    typeof value.runTrial !== 'function' ||
    (value.preflight !== undefined && typeof value.preflight !== 'function')
  ) {
    throw new TypeError('activation campaign contract is invalid');
  }
  return value;
}

function expectedConfirmation(contract, { release, runId, guildId }) {
  return `${contract.campaignConfirmationPrefix}${release}:${runId}:${guildId}`;
}

function validateRequest(options, contract) {
  if (!record(options)) throw new TypeError('activation campaign request is invalid');
  if (!RELEASE.test(options.release ?? '') || !RELEASE.test(options.hostVersion ?? ''))
    throw new TypeError('activation campaign request is invalid');
  if (!RUN_ID.test(options.runId ?? '') || !COMMIT.test(options.sourceCommit ?? ''))
    throw new TypeError('activation campaign request is invalid');
  if (!CONTROLLED_GUILD_IDS.includes(options.guildId))
    throw new TypeError('activation campaign request is invalid');
  if (options.confirmation !== expectedConfirmation(contract, options))
    throw new TypeError('activation campaign confirmation is invalid');
  if (typeof options.token !== 'string' || options.token.trim() === '')
    throw new TypeError('activation campaign request is invalid');
  if (typeof options.cwd !== 'string' || options.cwd.trim() === '')
    throw new TypeError('activation campaign request is invalid');
  if (typeof options.artifactRoot !== 'string' || !isAbsolute(options.artifactRoot))
    throw new TypeError('activation campaign request is invalid');
  const value = options.token.trim();
  return {
    release: options.release,
    runId: options.runId,
    hostVersion: options.hostVersion,
    sourceCommit: options.sourceCommit,
    guildId: options.guildId,
    confirmation: options.confirmation,
    token: value.startsWith('Bot ') ? value.slice(4).trim() : value,
    cwd: options.cwd,
    artifactRoot: options.artifactRoot,
  };
}

function parseArgs(argv, contract) {
  if (!Array.isArray(argv)) throw new TypeError('activation campaign arguments are invalid');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS.has(flag) || Object.hasOwn(values, flag))
      throw new TypeError('activation campaign arguments are invalid');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('activation campaign arguments are invalid');
    values[flag] = value;
  }
  for (const flag of FLAGS) {
    if (!Object.hasOwn(values, flag))
      throw new TypeError('activation campaign arguments are invalid');
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
    parsed.confirmation !== expectedConfirmation(contract, parsed)
  ) {
    throw new TypeError('activation campaign arguments are invalid');
  }
  return parsed;
}

function campaignFailure(contract, failedTrial = null, completedTrials = 0) {
  return {
    schema_version: contract.campaignSchema,
    ok: false,
    completed_trials: completedTrials,
    ...(failedTrial === null ? {} : { failed_trial: failedTrial }),
  };
}

async function runCampaign(options, contract, dependencies = {}) {
  const request = validateRequest(options, contract);
  const runTrial = dependencies.runTrial ?? contract.runTrial;
  const validateTrial = dependencies.validateTrial ?? assertActivationTrialArtifact;
  const verifyAggregate = dependencies.verifyAggregate ?? verifyActivationTrialAggregate;
  const prepareStore = dependencies.prepareStore ?? prepareArtifactStore;
  const preflight =
    dependencies.preflight ?? (runTrial === contract.runTrial ? contract.preflight : null);
  if (
    typeof runTrial !== 'function' ||
    typeof validateTrial !== 'function' ||
    typeof verifyAggregate !== 'function' ||
    typeof prepareStore !== 'function' ||
    (preflight !== null && preflight !== undefined && typeof preflight !== 'function')
  ) {
    throw new TypeError('activation campaign dependencies are invalid');
  }
  if (
    runTrial === contract.runTrial &&
    resolve(process.env.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT ?? '') !==
      resolve(request.artifactRoot)
  ) {
    throw new Error('activation campaign artifact root does not match the live adapter');
  }
  if (preflight) await preflight({ request });
  const store = await prepareStore({
    cwd: request.cwd,
    artifactRoot: request.artifactRoot,
    runId: request.runId,
  });
  if (typeof store?.writeArtifact !== 'function')
    throw new Error('activation campaign artifact store is unavailable');

  const artifacts = [];
  for (const trialId of contract.trialIds) {
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
        operatorConfirmation: `${contract.trialConfirmationPrefix}${request.release}:${trialId}`,
        writeApproval: `${contract.writeConfirmationPrefix}${request.release}:${trialId}`,
        token: request.token,
        executionMode: 'live',
      });
      if (
        !record(result) ||
        Object.keys(result).sort().join('\0') !== 'artifact\0ok' ||
        typeof result.ok !== 'boolean'
      ) {
        throw new Error('activation trial result shape mismatch');
      }
      assertSecretFreeJson(result, 'activation_campaign_trial_result');
      if (JSON.stringify(result).includes(request.token))
        throw new Error('activation trial result contains the Discord token');
      if (validateTrial(result.artifact) === false)
        throw new Error('activation trial artifact is invalid');
      if (
        result.artifact.trial_id !== trialId ||
        result.artifact.host !== contract.host ||
        result.artifact.host_version !== request.hostVersion ||
        result.artifact.release !== request.release ||
        result.artifact.source_commit !== request.sourceCommit ||
        result.artifact.execution_mode !== 'live'
      ) {
        throw new Error('activation trial identity mismatch');
      }
      if (result.ok ? result.artifact.result !== 'passed' : result.artifact.result !== 'failed')
        throw new Error('activation trial result mismatch');
      await store.writeArtifact(`results/${trialId}.json`, result.artifact);
    } catch {
      await store.writeArtifact(`results/${trialId}.failure.json`, {
        schema_version: contract.trialFailureSchema,
        trial_id: trialId,
        result: 'failed',
        error: 'activation trial did not produce a valid artifact',
      });
      throw new Error('activation trial failed before producing a valid artifact');
    }
    if (result.ok !== true) {
      const failure = campaignFailure(contract, result.artifact, artifacts.length);
      assertSecretFreeJson(failure, 'activation_campaign_failure');
      return failure;
    }
    artifacts.push(result.artifact);
  }

  const bundle = { schema_version: ACTIVATION_BUNDLE_SCHEMA, trials: artifacts };
  assertSecretFreeJson(bundle, 'activation_campaign_bundle');
  const verification = verifyAggregate({
    trials: artifacts,
    expectedHosts: [contract.host],
    expectedRelease: request.release,
    expectedCommit: request.sourceCommit,
  });
  if (verification?.schema_version !== ACTIVATION_VERIFIER_SCHEMA || verification.verified !== true)
    throw new Error('activation campaign public verification failed');
  assertSecretFreeJson(verification, 'activation_campaign_public_verification');
  await store.writeArtifact('results/activation-trials-bundle.json', bundle);
  const result = {
    schema_version: contract.campaignSchema,
    ok: true,
    bundle_relative_path: `runs/${request.runId}/results/activation-trials-bundle.json`,
    public_aggregate: verification,
  };
  assertSecretFreeJson(result, 'activation_campaign_result');
  return result;
}

function environmentToken(environment) {
  const value = environment.DISCORD_TESTBOT_B_TOKEN?.trim();
  const token = value?.startsWith('Bot ') ? value.slice(4).trim() : value;
  if (!token) throw new Error('activation campaign environment is incomplete');
  return token;
}

/** Build a thin host-specific campaign surface over the shared safety lifecycle. */
export function createActivationCampaign(contractInput) {
  const validated = assertContract(contractInput);
  const contract = Object.freeze({
    ...validated,
    trialIds: Object.freeze([...validated.trialIds]),
  });
  const parse = (argv) => parseArgs(argv, contract);
  const run = (options = {}, dependencies = {}) => runCampaign(options, contract, dependencies);
  const main = async ({
    argv = process.argv.slice(2),
    environment = process.env,
    stdout = process.stdout,
    runCampaign: execute = run,
  } = {}) => {
    try {
      const parsed = parse(argv);
      const artifactRoot = environment.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT;
      if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot))
        throw new Error('activation campaign environment is incomplete');
      const token = environmentToken(environment);
      const result = await execute({
        ...parsed,
        token,
        artifactRoot,
        cwd: resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
      });
      assertSecretFreeJson(result, 'activation_campaign_cli_result');
      if (JSON.stringify(result).includes(token))
        throw new Error('activation campaign result is unsafe');
      stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok === true ? 0 : 1;
    } catch {
      stdout.write(
        `${JSON.stringify({
          schema_version: contract.campaignSchema,
          ok: false,
          error: 'activation campaign failed',
        })}\n`,
      );
      return 1;
    }
  };
  return Object.freeze({ parseArgs: parse, run, main });
}
