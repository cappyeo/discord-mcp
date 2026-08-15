#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createActivationDependencies,
  createActivationWorkspace,
} from './activation-dependencies.mjs';
import { runActivationTrial } from './activation-trial.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { createCodexActivationLiveAdapter } from './codex-activation-live-adapter.mjs';

export const CODEX_ACTIVATION_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION:';
export const CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION_WRITE:';
export const CODEX_ACTIVATION_MAX_DURATION_MS = 600_000;
export const CODEX_ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
export const CODEX_ACTIVATION_RECOVERY_TIMEOUT_MS = 30_000;
export const CODEX_ACTIVATION_CANCELLATION_TIMEOUT_MS = 5_000;
export const CODEX_ACTIVATION_MAX_BUFFER = 10 * 1024 * 1024;
export const CODEX_ACTIVATION_PHASES = Object.freeze([
  'install',
  'setup',
  'client_ready',
  'first_request',
  'apply',
  'evidence',
  'restore',
  'total',
]);

const SNOWFLAKE = /^\d{17,20}$/;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const TRIAL = /^[a-z][a-z0-9._-]{2,63}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const EXECUTION_MODES = new Set(['live', 'test']);
const TRUSTED_LIVE_DEPENDENCIES = new WeakSet();
const ACTIVATION_CLI_FLAGS = new Set([
  '--release',
  '--run-id',
  '--trial-id',
  '--host-version',
  '--source-commit',
  '--guild',
  '--confirmation',
  '--write-approval',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
}

function normalizeDiscordToken(token) {
  return token.startsWith('Bot ') ? token.slice(4) : token;
}

function expectedConfirmation(release, trialId) {
  return `${CODEX_ACTIVATION_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

function expectedWriteConfirmation(release, trialId) {
  return `${CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

/** Validate all operator-controlled identity and consent before touching Discord. */
export function validateCodexActivationRequest(options = {}) {
  if (!record(options)) throw new TypeError('activation request must be an object');
  assertString(options.release, 'release', RELEASE);
  assertString(options.runId, 'runId', TRIAL);
  assertString(options.trialId, 'trialId', TRIAL);
  assertString(options.hostVersion, 'hostVersion', RELEASE);
  assertString(options.sourceCommit, 'sourceCommit', COMMIT);
  if (!record(options.target)) throw new TypeError('controlled target is required');
  assertString(options.target.guildId, 'target.guildId', SNOWFLAKE);
  assertString(options.target.botId, 'target.botId', SNOWFLAKE);
  if (options.target.controlled !== true)
    throw new TypeError('controlled target confirmation is required');
  if (options.target.callerOwned !== true)
    throw new TypeError('caller-owned bot confirmation is required');
  const confirmation = options.operatorConfirmation ?? options.confirmation;
  if (confirmation !== expectedConfirmation(options.release, options.trialId))
    throw new TypeError('operator confirmation does not match release and trial');
  const writeApproval = options.writeApproval ?? options.writeConfirmation;
  if (
    writeApproval !== undefined &&
    writeApproval !== expectedWriteConfirmation(options.release, options.trialId)
  )
    throw new TypeError('write approval does not match release and trial');
  if (options.maxDurationMs !== undefined) {
    if (
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > CODEX_ACTIVATION_MAX_DURATION_MS
    )
      throw new TypeError('maxDurationMs must be between 1 and 600000');
  }
  assertString(options.token, 'token', /.+/);
  const token = normalizeDiscordToken(options.token);
  assertString(token, 'token', /.+/);
  const executionMode = options.executionMode ?? 'live';
  if (!EXECUTION_MODES.has(executionMode))
    throw new TypeError('executionMode must be live or test');
  return {
    runId: options.runId,
    release: options.release,
    trialId: options.trialId,
    target: { ...options.target },
    operatorConfirmation: confirmation,
    writeApproval,
    hostVersion: options.hostVersion,
    sourceCommit: options.sourceCommit,
    maxDurationMs: options.maxDurationMs ?? CODEX_ACTIVATION_MAX_DURATION_MS,
    token,
    executionMode,
  };
}

function configHasLine(config, name, value) {
  return new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*${value}(?:\\s|#|$)`, 'm').test(config);
}

function parseGuidedSetupJson(stdout, target) {
  if (typeof stdout !== 'string' || stdout.trim() === '')
    throw new Error('guided setup did not emit JSON output');
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error('guided setup emitted invalid JSON output');
  }
  if (!record(output) || output.ok !== true || (output.exitCode ?? 0) !== 0)
    throw new Error('guided setup JSON result was not successful');
  const data = output.data;
  const botId = data?.discord?.bot?.id;
  const allowedGuilds = data?.allowedGuilds;
  if (
    !SNOWFLAKE.test(target.guildId ?? '') ||
    !SNOWFLAKE.test(target.botId ?? '') ||
    !SNOWFLAKE.test(botId ?? '') ||
    botId !== target.botId
  )
    throw new Error('guided setup authenticated bot does not match the target bot');
  if (
    !Array.isArray(allowedGuilds) ||
    allowedGuilds.length !== 1 ||
    allowedGuilds[0] !== target.guildId
  )
    throw new Error('guided setup allowed guilds do not exactly match the target guild');
  return {
    binding: { guildId: target.guildId, botId },
    bindingVerified: true,
    setupOutput: output,
  };
}

/** The exact guided setup command used by the public package adapter. */
export function buildCodexSetupArgs({ profile, guildId, configPath }) {
  assertString(profile, 'profile', TRIAL);
  assertString(guildId, 'guildId', SNOWFLAKE);
  if (typeof configPath !== 'string' || configPath.length === 0)
    throw new TypeError('configPath is required');
  return [
    'setup',
    '--profile',
    profile,
    '--client',
    'codex',
    '--allowed-guilds',
    guildId,
    '--output',
    configPath,
    '--force',
    '--json',
  ];
}

/**
 * Validate generated Codex TOML without ever returning it from the benchmark.
 * The generated snippet must pin the public release and forward the token by
 * name; the token value itself is supplied only in the child process env.
 */
export function assertCodexConfigReady(config, { release, token }) {
  if (typeof config !== 'string' || config.length === 0)
    throw new TypeError('generated Codex config is empty');
  if (typeof token === 'string' && token !== '' && config.includes(token))
    throw new Error('generated Codex config contains the Discord token');
  if (!config.includes(`@discord-mcp/cli@${release}`))
    throw new Error('generated Codex config is not pinned to the requested release');
  if (!/env_vars\s*=\s*\[\s*"DISCORD_TOKEN"\s*\]/m.test(config))
    throw new Error('generated Codex config must forward only DISCORD_TOKEN');
  if (!configHasLine(config, 'startup_timeout_sec', '(?:90|180)'))
    throw new Error('generated Codex config has no safe startup timeout');
  if (!configHasLine(config, 'tool_timeout_sec', '180'))
    throw new Error('generated Codex config has no 180 second tool timeout');
  return true;
}

function assertCodexConfigWritable(config) {
  if (!config.includes('MCP_DRY_RUN') || !config.includes('MCP_WRITE_MODE'))
    throw new Error('write mode was not explicitly enabled after operator approval');
  if (!/MCP_DRY_RUN\s*=\s*"false"/.test(config)) throw new Error('MCP_DRY_RUN is not false');
  if (!/MCP_WRITE_MODE\s*=\s*"allow"/.test(config)) throw new Error('MCP_WRITE_MODE is not allow');
}

/**
 * Public package adapter. Install, guided setup, host launch, Discord
 * readback, and restoration are real and disposable. Host-specific setup,
 * config, and live-client seams are supplied by the caller.
 */
export function createDefaultCodexActivationDependencies(options = {}) {
  if (!record(options)) throw new TypeError('dependency options must be an object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('dependency options must not inherit activation seams');
  const runCommand = options.runCommand;
  const verifyProvenance = options.verifyProvenance;
  const resolveNpmCli = options.resolveNpmCli;
  const providedEnvironment = options.environment;
  const authPreflight = options.authPreflight;
  const environment = providedEnvironment ?? process.env;
  const usesOnlyBuiltIns =
    Reflect.ownKeys(options).length === 0 &&
    runCommand === undefined &&
    verifyProvenance === undefined &&
    resolveNpmCli === undefined &&
    providedEnvironment === undefined &&
    authPreflight === undefined;
  const dependencies = createActivationDependencies({
    host: 'codex',
    runCommand,
    verifyProvenance,
    environment,
    resolveNpmCli,
    setupArgs: buildCodexSetupArgs,
    parseSetup: parseGuidedSetupJson,
    assertConfigReady: assertCodexConfigReady,
    assertConfigWritable: assertCodexConfigWritable,
    enableWrites: async ({ configPath, config }) => {
      const updated = `${config.trimEnd()}\n\n[mcp_servers.discord-mcp.env]\nMCP_DRY_RUN = "false"\nMCP_WRITE_MODE = "allow"\n`;
      await writeFile(configPath, updated, 'utf8');
      return { config: updated };
    },
    buildEnvironment: ({ childEnvironment, home, profileRoot, profileEnvironmentKey, token }) => ({
      ...childEnvironment,
      CODEX_HOME: home,
      [profileEnvironmentKey]: profileRoot,
      DISCORD_TOKEN: token,
    }),
    createLiveAdapter: ({ environment: liveEnvironment, verifyRuntimePackage }) =>
      createCodexActivationLiveAdapter({
        environment: liveEnvironment,
        verifyRuntimePackage,
      }),
    executionProvenance: {
      execution_mode: 'live',
      adapter_id: 'discord-mcp.codex-activation.v1',
      abortable: true,
      package_source: 'verified_npm_provenance',
    },
    authPreflight,
  });
  if (usesOnlyBuiltIns) TRUSTED_LIVE_DEPENDENCIES.add(dependencies);
  return dependencies;
}

function profileEnvironmentKey() {
  return process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
}

/**
 * Run one clean Codex activation trial through the host-neutral runner.
 * The Codex request/configuration/production dependency factory stay in this
 * module so existing callers and the public benchmark CLI remain unchanged.
 */
export async function runCodexActivationTrial(options = {}) {
  const request = validateCodexActivationRequest(options);
  const dependencies = options.dependencies ?? createDefaultCodexActivationDependencies();
  const runnerDependencies =
    dependencies.workspace === undefined
      ? { ...dependencies, workspace: createActivationWorkspace({ host: 'codex' }) }
      : dependencies;
  const authPreflight = options.authPreflight ?? dependencies.authPreflight;
  if (typeof authPreflight === 'function') await authPreflight({ request });
  return runActivationTrial({
    request,
    dependencies: runnerDependencies,
    clock: options.clock,
    host: 'codex',
    limits: {
      phaseTimeoutMs: CODEX_ACTIVATION_PHASE_TIMEOUT_MS,
      recoveryTimeoutMs: CODEX_ACTIVATION_RECOVERY_TIMEOUT_MS,
      cancellationTimeoutMs: CODEX_ACTIVATION_CANCELLATION_TIMEOUT_MS,
    },
    assertConfigReady: assertCodexConfigReady,
    assertConfigWritable: assertCodexConfigWritable,
    resolveProfileEnvironmentKey: (workspaceState) =>
      workspaceState.profileEnvironmentKey ?? profileEnvironmentKey(),
    buildLaunchEnvironment: ({ workspaceState, request: activationRequest }) => ({
      CODEX_HOME: workspaceState.home,
      [workspaceState.profileEnvironmentKey ?? profileEnvironmentKey()]: workspaceState.profileRoot,
      DISCORD_TOKEN: activationRequest.token,
      MCP_DRY_RUN: 'false',
      MCP_WRITE_MODE: 'allow',
    }),
    isTrustedLiveDependencies: (value) => TRUSTED_LIVE_DEPENDENCIES.has(value),
  });
}

export function parseCodexActivationArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('activation arguments must be an array');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!ACTIVATION_CLI_FLAGS.has(flag)) throw new TypeError('invalid activation arguments');
    if (Object.hasOwn(values, flag)) throw new TypeError('invalid activation arguments');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new TypeError('invalid activation arguments');
    }
    values[flag] = value;
  }
  for (const flag of ACTIVATION_CLI_FLAGS) {
    if (!Object.hasOwn(values, flag)) throw new TypeError('invalid activation arguments');
  }
  if (!CONTROLLED_GUILD_IDS.includes(values['--guild'])) {
    throw new TypeError('invalid activation arguments');
  }
  return {
    release: values['--release'],
    runId: values['--run-id'],
    trialId: values['--trial-id'],
    hostVersion: values['--host-version'],
    sourceCommit: values['--source-commit'],
    guildId: values['--guild'],
    operatorConfirmation: values['--confirmation'],
    writeApproval: values['--write-approval'],
  };
}

function activationCliToken(environment) {
  const token = environment.DISCORD_TESTBOT_B_TOKEN?.trim();
  if (!token) throw new Error('activation environment is incomplete');
  return token.startsWith('Bot ') ? token.slice(4) : token;
}

function activationCliFailure() {
  return {
    schema_version: 'discord-mcp.activation-trial-cli.v1',
    ok: false,
    error: 'activation trial failed',
  };
}

/** Secret-free operator boundary for one authoritative Codex activation trial. */
export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  runTrial = runCodexActivationTrial,
} = {}) {
  try {
    const options = parseCodexActivationArgs(argv);
    const token = activationCliToken(environment);
    const result = await runTrial({
      release: options.release,
      runId: options.runId,
      trialId: options.trialId,
      hostVersion: options.hostVersion,
      sourceCommit: options.sourceCommit,
      target: {
        guildId: options.guildId,
        botId: CONTROLLED_BOT_ID,
        controlled: true,
        callerOwned: true,
      },
      operatorConfirmation: options.operatorConfirmation,
      writeApproval: options.writeApproval,
      token,
      executionMode: 'live',
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch {
    stdout.write(`${JSON.stringify(activationCliFailure())}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
