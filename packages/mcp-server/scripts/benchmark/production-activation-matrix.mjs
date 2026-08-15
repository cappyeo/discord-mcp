#!/usr/bin/env node

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  runAntigravityCliActivationCampaign,
} from './antigravity-cli-activation-campaign.mjs';
import { assertAntigravityCliActivationAuthReady } from './antigravity-cli-activation-trial.mjs';
import {
  resolveAntigravityLauncher,
  runBoundedAntigravityProcess,
} from './antigravity-cli-driver.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import {
  CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  runClaudeCodeActivationCampaign,
} from './claude-code-activation-campaign.mjs';
import { assertClaudeCodeActivationAuthReady } from './claude-code-activation-trial.mjs';
import { resolveClaudeCodeLauncher, runBoundedClaudeCodeProcess } from './claude-code-driver.mjs';
import {
  CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  runCodexActivationCampaign,
} from './codex-activation-campaign.mjs';
import {
  CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  runCursorCliActivationCampaign,
} from './cursor-cli-activation-campaign.mjs';
import { assertCursorCliActivationAuthReady } from './cursor-cli-activation-trial.mjs';
import { resolveCursorCliLauncher, runBoundedCursorCliProcess } from './cursor-cli-driver.mjs';
import {
  GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  runGrokCliActivationCampaign,
} from './grok-cli-activation-campaign.mjs';
import { assertGrokCliActivationAuthReady } from './grok-cli-activation-trial.mjs';
import { resolveGrokCliLauncher, runBoundedGrokCliProcess } from './grok-cli-driver.mjs';
import { assertSecretFreeJson } from './manifest.mjs';
import { resolveCodexLauncher } from './small-model-eval.mjs';
import { preparePrivateCodexHome, runBoundedCodexProcess } from './small-model-live-eval.mjs';
import { buildActivationMatrixCampaigns } from './verify-activation-matrix.mjs';
import {
  ACTIVATION_VERIFIER_SCHEMA,
  PRODUCTION_ACTIVATION_HOSTS,
  verifyProductionActivationMatrix,
} from './verify-activation-trials.mjs';

export const PRODUCTION_ACTIVATION_MATRIX_SCHEMA = 'discord-mcp.production-activation-matrix.v1';
export const PRODUCTION_ACTIVATION_MATRIX_CONFIRMATION_PREFIX =
  'APPROVE_FIVE_HOST_ACTIVATION_MATRIX:';

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;
const RUN_ID = /^[a-z][a-z0-9._-]{2,31}$/;
const HOST_RUN_ID = /^[a-z][a-z0-9._-]{2,63}$/;
const HOST_VERSION_TIMEOUT_MS = 15_000;
const HOST_VERSION_ENVIRONMENT_KEYS = Object.freeze([
  'APPDATA',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PSModulePath',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'USERNAME',
]);
const FLAGS = new Map([
  ['--release', 'release'],
  ['--run-id', 'runId'],
  ['--source-commit', 'sourceCommit'],
  ['--guild', 'guildId'],
  ['--confirmation', 'confirmation'],
  ...PRODUCTION_ACTIVATION_HOSTS.map((host) => [`--${host}-version`, host]),
]);
const HOST_CONTRACTS = Object.freeze([
  Object.freeze({
    host: 'codex',
    confirmationPrefix: CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
    runCampaign: runCodexActivationCampaign,
  }),
  Object.freeze({
    host: 'claude-code',
    confirmationPrefix: CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
    runCampaign: runClaudeCodeActivationCampaign,
  }),
  Object.freeze({
    host: 'antigravity-cli',
    confirmationPrefix: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
    runCampaign: runAntigravityCliActivationCampaign,
  }),
  Object.freeze({
    host: 'cursor-cli',
    confirmationPrefix: CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
    runCampaign: runCursorCliActivationCampaign,
  }),
  Object.freeze({
    host: 'grok-cli',
    confirmationPrefix: GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
    runCampaign: runGrokCliActivationCampaign,
  }),
]);
const SORTED_PRODUCTION_ACTIVATION_HOSTS = Object.freeze([...PRODUCTION_ACTIVATION_HOSTS].sort());
const HOST_VERSION_PROBES = Object.freeze({
  codex: Object.freeze({
    resolveLauncher: resolveCodexLauncher,
    runProcess: runBoundedCodexProcess,
  }),
  'claude-code': Object.freeze({
    resolveLauncher: resolveClaudeCodeLauncher,
    runProcess: runBoundedClaudeCodeProcess,
  }),
  'antigravity-cli': Object.freeze({
    resolveLauncher: resolveAntigravityLauncher,
    runProcess: runBoundedAntigravityProcess,
  }),
  'cursor-cli': Object.freeze({
    resolveLauncher: resolveCursorCliLauncher,
    runProcess: runBoundedCursorCliProcess,
  }),
  'grok-cli': Object.freeze({
    resolveLauncher: resolveGrokCliLauncher,
    runProcess: runBoundedGrokCliProcess,
  }),
});
const NOOP_PREFLIGHT = async () => true;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return record(value) && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function productionActivationMatrixConfirmation({
  release,
  runId,
  guildId,
  sourceCommit,
} = {}) {
  return `${PRODUCTION_ACTIVATION_MATRIX_CONFIRMATION_PREFIX}${release}:${runId}:${guildId}:${CONTROLLED_BOT_ID}:${sourceCommit}`;
}

export function productionActivationRunIds(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId))
    throw new TypeError('production activation matrix run id is invalid');
  const entries = PRODUCTION_ACTIVATION_HOSTS.map((host) => [host, `${runId}-${host}`]);
  if (entries.some(([, value]) => !HOST_RUN_ID.test(value)))
    throw new TypeError('production activation matrix run id is invalid');
  return Object.fromEntries(entries);
}

export function validateProductionActivationMatrixRequest(options = {}) {
  if (!record(options)) throw new TypeError('production activation matrix request is invalid');
  if (
    !RELEASE.test(options.release ?? '') ||
    !RUN_ID.test(options.runId ?? '') ||
    !COMMIT.test(options.sourceCommit ?? '') ||
    !CONTROLLED_GUILD_IDS.includes(options.guildId) ||
    options.confirmation !== productionActivationMatrixConfirmation(options) ||
    typeof options.token !== 'string' ||
    options.token.trim() === '' ||
    typeof options.cwd !== 'string' ||
    options.cwd.trim() === '' ||
    typeof options.artifactRoot !== 'string' ||
    !isAbsolute(options.artifactRoot) ||
    !exactKeys(options.hostVersions, PRODUCTION_ACTIVATION_HOSTS) ||
    PRODUCTION_ACTIVATION_HOSTS.some((host) => !RELEASE.test(options.hostVersions[host] ?? ''))
  ) {
    throw new TypeError('production activation matrix request is invalid');
  }
  const tokenInput = options.token.trim();
  const token = tokenInput.startsWith('Bot ') ? tokenInput.slice(4).trim() : tokenInput;
  if (token === '') throw new TypeError('production activation matrix request is invalid');
  return {
    release: options.release,
    runId: options.runId,
    sourceCommit: options.sourceCommit,
    guildId: options.guildId,
    confirmation: options.confirmation,
    token,
    cwd: options.cwd,
    artifactRoot: options.artifactRoot,
    hostVersions: { ...options.hostVersions },
  };
}

export function parseProductionActivationMatrixArgs(argv) {
  if (!Array.isArray(argv))
    throw new TypeError('production activation matrix arguments are invalid');
  const values = {};
  const hostVersions = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!FLAGS.has(flag) || seen.has(flag))
      throw new TypeError('production activation matrix arguments are invalid');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('production activation matrix arguments are invalid');
    seen.add(flag);
    const key = FLAGS.get(flag);
    if (PRODUCTION_ACTIVATION_HOSTS.includes(key)) hostVersions[key] = value;
    else values[key] = value;
  }
  const parsed = { ...values, hostVersions };
  if (
    seen.size !== FLAGS.size ||
    !RELEASE.test(parsed.release ?? '') ||
    !RUN_ID.test(parsed.runId ?? '') ||
    !COMMIT.test(parsed.sourceCommit ?? '') ||
    !CONTROLLED_GUILD_IDS.includes(parsed.guildId) ||
    parsed.confirmation !== productionActivationMatrixConfirmation(parsed) ||
    !exactKeys(hostVersions, PRODUCTION_ACTIVATION_HOSTS) ||
    PRODUCTION_ACTIVATION_HOSTS.some((host) => !RELEASE.test(hostVersions[host] ?? ''))
  ) {
    throw new TypeError('production activation matrix arguments are invalid');
  }
  return parsed;
}

function hostVersionEnvironment(environment) {
  const selected = {};
  for (const key of HOST_VERSION_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && environment[key] !== '')
      selected[key] = environment[key];
  }
  return selected;
}

async function probeHostVersion({ probe, cwd, environment }) {
  if (
    !record(probe) ||
    typeof probe.resolveLauncher !== 'function' ||
    typeof probe.runProcess !== 'function'
  ) {
    throw new TypeError('production activation host version probe is invalid');
  }
  const launcher = await probe.resolveLauncher();
  const result = await probe.runProcess({
    launcher,
    args: ['--version'],
    cwd,
    env: environment,
    timeoutMs: HOST_VERSION_TIMEOUT_MS,
  });
  if (
    !record(result) ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut !== false ||
    result.aborted !== false ||
    result.spawnError !== false ||
    result.truncated !== false
  ) {
    throw new Error('production activation host version preflight failed');
  }
  const version = HOST_VERSION.exec(result.stdout ?? '')?.[1];
  if (version === undefined) throw new Error('production activation host version preflight failed');
  return version;
}

export async function preflightProductionActivationHosts(
  { environment, hostVersions, cwd } = {},
  { versionProbes = HOST_VERSION_PROBES } = {},
) {
  if (
    !record(environment) ||
    !exactKeys(hostVersions, PRODUCTION_ACTIVATION_HOSTS) ||
    typeof cwd !== 'string' ||
    cwd.trim() === '' ||
    !exactKeys(versionProbes, PRODUCTION_ACTIVATION_HOSTS)
  ) {
    throw new TypeError('production activation host preflight is invalid');
  }
  assertClaudeCodeActivationAuthReady(environment);
  assertAntigravityCliActivationAuthReady(environment);
  assertCursorCliActivationAuthReady(environment);
  assertGrokCliActivationAuthReady(environment);
  const privateHome = await preparePrivateCodexHome({ env: environment });
  await privateHome.cleanup();
  const versionEnvironment = hostVersionEnvironment(environment);
  for (const host of PRODUCTION_ACTIVATION_HOSTS) {
    const version = await probeHostVersion({
      probe: versionProbes[host],
      cwd,
      environment: versionEnvironment,
    });
    if (version !== hostVersions[host])
      throw new Error('production activation host version preflight failed');
  }
  return true;
}

function assertCampaignResult(result, { host, runId, request, buildDigest }) {
  if (
    !record(result) ||
    result.ok !== true ||
    result.bundle_relative_path !== `runs/${runId}/results/activation-trials-bundle.json` ||
    !record(result.public_aggregate) ||
    result.public_aggregate.schema_version !== ACTIVATION_VERIFIER_SCHEMA ||
    result.public_aggregate.verified !== true ||
    result.public_aggregate.host_count !== 1 ||
    result.public_aggregate.release !== request.release ||
    result.public_aggregate.source_commit !== request.sourceCommit ||
    !Array.isArray(result.public_aggregate.hosts) ||
    result.public_aggregate.hosts.length !== 1 ||
    result.public_aggregate.hosts[0]?.host !== host ||
    result.public_aggregate.hosts[0]?.trial_count !== 3 ||
    !DIGEST.test(result.public_aggregate.build_digest ?? '') ||
    (buildDigest !== null && result.public_aggregate.build_digest !== buildDigest)
  ) {
    throw new Error('production activation host campaign result is invalid');
  }
  assertSecretFreeJson(result, 'production_activation_host_campaign');
  if (JSON.stringify(result).includes(request.token))
    throw new Error('production activation host campaign contains the Discord token');
  return result.public_aggregate.build_digest;
}

/** Run the exact five-host campaign sequence, then authenticate the 15-trial matrix. */
export async function runProductionActivationMatrix(options = {}, dependencies = {}) {
  const request = validateProductionActivationMatrixRequest(options);
  if (!record(dependencies))
    throw new TypeError('production activation matrix dependencies are invalid');
  const preflight = dependencies.preflight ?? preflightProductionActivationHosts;
  const verifyMatrix = dependencies.verifyMatrix ?? verifyProductionActivationMatrix;
  const validateActivityEvidence = dependencies.validateActivityEvidence;
  const runCampaigns =
    dependencies.runCampaigns ??
    Object.fromEntries(HOST_CONTRACTS.map(({ host, runCampaign }) => [host, runCampaign]));
  if (
    typeof preflight !== 'function' ||
    typeof verifyMatrix !== 'function' ||
    typeof validateActivityEvidence !== 'function' ||
    !exactKeys(runCampaigns, PRODUCTION_ACTIVATION_HOSTS) ||
    PRODUCTION_ACTIVATION_HOSTS.some((host) => typeof runCampaigns[host] !== 'function')
  ) {
    throw new TypeError('production activation matrix dependencies are invalid');
  }
  const environment = dependencies.environment ?? process.env;
  await preflight({
    environment,
    hostVersions: request.hostVersions,
    cwd: request.cwd,
  });

  const runIds = productionActivationRunIds(request.runId);
  let buildDigest = null;
  for (const contract of HOST_CONTRACTS) {
    const runId = runIds[contract.host];
    const result = await runCampaigns[contract.host](
      {
        release: request.release,
        runId,
        hostVersion: request.hostVersions[contract.host],
        sourceCommit: request.sourceCommit,
        guildId: request.guildId,
        confirmation: `${contract.confirmationPrefix}${request.release}:${runId}:${request.guildId}`,
        token: request.token,
        cwd: request.cwd,
        artifactRoot: request.artifactRoot,
      },
      { preflight: NOOP_PREFLIGHT },
    );
    buildDigest = assertCampaignResult(result, {
      host: contract.host,
      runId,
      request,
      buildDigest,
    });
  }

  const publicAggregate = await verifyMatrix({
    campaigns: buildActivationMatrixCampaigns(request.artifactRoot, runIds),
    integrityKey: request.token,
    expectedBinding: { guildId: request.guildId, botId: CONTROLLED_BOT_ID },
    expectedRelease: request.release,
    expectedCommit: request.sourceCommit,
    expectedBuildDigest: buildDigest,
    validateActivityEvidence,
  });
  if (
    !record(publicAggregate) ||
    publicAggregate.schema_version !== ACTIVATION_VERIFIER_SCHEMA ||
    publicAggregate.verified !== true ||
    publicAggregate.host_count !== PRODUCTION_ACTIVATION_HOSTS.length ||
    publicAggregate.release !== request.release ||
    publicAggregate.source_commit !== request.sourceCommit ||
    publicAggregate.build_digest !== buildDigest ||
    !Array.isArray(publicAggregate.hosts) ||
    publicAggregate.hosts.length !== PRODUCTION_ACTIVATION_HOSTS.length ||
    publicAggregate.hosts
      .map((host) => host?.host)
      .sort()
      .some((host, index) => host !== SORTED_PRODUCTION_ACTIVATION_HOSTS[index]) ||
    publicAggregate.hosts.some((host) => host?.trial_count !== 3)
  ) {
    throw new Error('production activation matrix verification is invalid');
  }
  const output = {
    schema_version: PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
    ok: true,
    matrix_run_id: request.runId,
    campaign_run_ids: runIds,
    public_aggregate: publicAggregate,
  };
  assertSecretFreeJson(output, 'production_activation_matrix');
  if (JSON.stringify(output).includes(request.token))
    throw new Error('production activation matrix contains the Discord token');
  return output;
}

function environmentToken(environment) {
  const value = environment.DISCORD_TESTBOT_B_TOKEN?.trim();
  const token = value?.startsWith('Bot ') ? value.slice(4).trim() : value;
  if (!token) throw new Error('production activation matrix environment is incomplete');
  return token;
}

function publicFailure() {
  return {
    schema_version: PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
    ok: false,
    error: 'production activation matrix failed',
  };
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  runMatrix = runProductionActivationMatrix,
  validateActivityEvidence,
} = {}) {
  try {
    const parsed = parseProductionActivationMatrixArgs(argv);
    const artifactRoot = environment.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT;
    if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot))
      throw new Error('production activation matrix environment is incomplete');
    if (environment.DISCORD_EXPECTED_BOT_ID !== CONTROLLED_BOT_ID)
      throw new Error('production activation matrix environment is incomplete');
    const token = environmentToken(environment);
    const validator =
      validateActivityEvidence ??
      (await import('@discord-mcp/core')).assertGuildBlueprintActivityEvidence;
    const result = await runMatrix(
      {
        ...parsed,
        token,
        artifactRoot,
        cwd: resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
      },
      {
        environment,
        validateActivityEvidence: validator,
      },
    );
    assertSecretFreeJson(result, 'production_activation_matrix_cli_result');
    if (JSON.stringify(result).includes(token))
      throw new Error('production activation matrix CLI result contains the Discord token');
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
