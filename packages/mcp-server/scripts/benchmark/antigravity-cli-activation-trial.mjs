#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationDependencies } from './activation-dependencies.mjs';
import { runActivationTrial } from './activation-trial.mjs';
import { createAntigravityCliActivationLiveAdapter } from './antigravity-cli-activation-live-adapter.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';

export const ANTIGRAVITY_CLI_ACTIVATION_CONFIRMATION_PREFIX = 'APPROVE_ANTIGRAVITY_CLI_ACTIVATION:';
export const ANTIGRAVITY_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX =
  'APPROVE_ANTIGRAVITY_CLI_ACTIVATION_WRITE:';
export const ANTIGRAVITY_CLI_ACTIVATION_MAX_DURATION_MS = 600_000;
export const ANTIGRAVITY_CLI_ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
export const ANTIGRAVITY_CLI_ACTIVATION_RECOVERY_TIMEOUT_MS = 30_000;
export const ANTIGRAVITY_CLI_ACTIVATION_CANCELLATION_TIMEOUT_MS = 5_000;

const SNOWFLAKE = /^\d{17,20}$/u;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const TRIAL = /^[a-z][a-z0-9._-]{2,63}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EXECUTION_MODES = new Set(['live', 'test']);
const GEMINI_API_KEY_MAX_BYTES = 4096;
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
  return token.startsWith('Bot ') ? token.slice(4).trim() : token.trim();
}

function expectedConfirmation(release, trialId) {
  return `${ANTIGRAVITY_CLI_ACTIVATION_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

function expectedWriteConfirmation(release, trialId) {
  return `${ANTIGRAVITY_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

function validateGeminiApiKey(value) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value))
    throw new Error('GEMINI_API_KEY preflight failed');
  if (Buffer.byteLength(value, 'utf8') > GEMINI_API_KEY_MAX_BYTES)
    throw new Error('GEMINI_API_KEY preflight failed');
  return value;
}

/** Validate Antigravity host authentication before campaign-local side effects. */
export function assertAntigravityCliActivationAuthReady(environment = process.env) {
  validateGeminiApiKey(environment?.GEMINI_API_KEY);
  return true;
}

function parseConfig(value, label) {
  if (record(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (record(parsed)) return parsed;
    } catch {
      // Return one bounded validation error without echoing config content.
    }
  }
  throw new TypeError(`${label} must be a JSON object`);
}

function assertSecretFree(value, token, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (token && text.includes(token)) throw new Error(`${label} contains the Discord token`);
  if (/DISCORD_TOKEN|GEMINI_API_KEY/iu.test(text))
    throw new Error(`${label} contains a credential reference`);
}

/** Validate all operator-controlled identity and consent before host side effects. */
export function validateAntigravityCliActivationRequest(options = {}) {
  if (!record(options)) throw new TypeError('Antigravity activation request must be an object');
  assertString(options.release, 'release', RELEASE);
  assertString(options.runId, 'runId', TRIAL);
  assertString(options.trialId, 'trialId', TRIAL);
  assertString(options.hostVersion, 'hostVersion', RELEASE);
  assertString(options.sourceCommit, 'sourceCommit', COMMIT);
  if (!record(options.target)) throw new TypeError('Antigravity controlled target is required');
  assertString(options.target.guildId, 'target.guildId', SNOWFLAKE);
  assertString(options.target.botId, 'target.botId', SNOWFLAKE);
  if (options.target.controlled !== true)
    throw new TypeError('Antigravity controlled target confirmation is required');
  if (options.target.callerOwned !== true)
    throw new TypeError('Antigravity caller-owned bot confirmation is required');
  const confirmation = options.operatorConfirmation ?? options.confirmation;
  if (confirmation !== expectedConfirmation(options.release, options.trialId))
    throw new TypeError('Antigravity operator confirmation does not match release and trial');
  const writeApproval = options.writeApproval ?? options.writeConfirmation;
  if (
    writeApproval !== undefined &&
    writeApproval !== expectedWriteConfirmation(options.release, options.trialId)
  )
    throw new TypeError('Antigravity write approval does not match release and trial');
  if (options.maxDurationMs !== undefined) {
    if (
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > ANTIGRAVITY_CLI_ACTIVATION_MAX_DURATION_MS
    )
      throw new TypeError('maxDurationMs must be between 1 and 600000');
  }
  assertString(options.token, 'token', /.+/u);
  const token = normalizeDiscordToken(options.token);
  assertString(token, 'token', /.+/u);
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
    maxDurationMs: options.maxDurationMs ?? ANTIGRAVITY_CLI_ACTIVATION_MAX_DURATION_MS,
    token,
    executionMode,
  };
}

export function buildAntigravityCliSetupArgs({ profile, guildId, configPath }) {
  assertString(profile, 'profile', TRIAL);
  assertString(guildId, 'guildId', SNOWFLAKE);
  if (typeof configPath !== 'string' || !isAbsolute(configPath))
    throw new TypeError('Antigravity configPath must be absolute');
  return [
    'setup',
    '--profile',
    profile,
    '--client',
    'antigravity-cli',
    '--allowed-guilds',
    guildId,
    '--output',
    configPath,
    '--force',
    '--json',
  ];
}

export function parseAntigravityCliSetupJson(stdout, target) {
  if (typeof stdout !== 'string' || stdout.trim() === '')
    throw new Error('Antigravity guided setup did not emit JSON output');
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error('Antigravity guided setup emitted invalid JSON output');
  }
  if (!record(output) || output.ok !== true || (output.exitCode ?? 0) !== 0)
    throw new Error('Antigravity guided setup JSON result was not successful');
  const botId = output.data?.discord?.bot?.id;
  const allowedGuilds = output.data?.allowedGuilds;
  if (
    !SNOWFLAKE.test(target.guildId ?? '') ||
    !SNOWFLAKE.test(target.botId ?? '') ||
    !SNOWFLAKE.test(botId ?? '') ||
    botId !== target.botId
  )
    throw new Error('Antigravity guided setup bot binding is invalid');
  if (
    !Array.isArray(allowedGuilds) ||
    allowedGuilds.length !== 1 ||
    allowedGuilds[0] !== target.guildId
  )
    throw new Error('Antigravity guided setup guild binding is invalid');
  return {
    binding: { guildId: target.guildId, botId },
    bindingVerified: true,
    setupOutput: output,
  };
}

function expectedServerArgs(release, profile) {
  return [
    '--yes',
    '--loglevel=error',
    `@discord-mcp/cli@${release}`,
    'serve',
    '--profile',
    profile,
  ];
}

export function assertAntigravityCliConfigReady(config, { release, token, profile } = {}) {
  const parsed = parseConfig(config, 'Antigravity generated config');
  assertSecretFree(parsed, token, 'Antigravity generated config');
  const server = parsed.mcpServers?.['discord-mcp'];
  if (
    Object.keys(parsed).length !== 1 ||
    !record(parsed.mcpServers) ||
    Object.keys(parsed.mcpServers).length !== 1 ||
    !record(server) ||
    Object.keys(server).sort().join(',') !== 'args,command' ||
    server.command !== 'npx' ||
    !Array.isArray(server.args) ||
    JSON.stringify(server.args) !== JSON.stringify(expectedServerArgs(release, profile))
  )
    throw new Error('Antigravity generated config is not pinned to the release and profile');
  return true;
}

function canonicalAllowConfig({ request, workspaceState, install }) {
  if (!record(request) || !record(workspaceState) || !record(install))
    throw new TypeError('Antigravity canonical config context is required');
  if (!DIGEST.test(install.cliDigest ?? ''))
    throw new Error('Antigravity install provenance is unavailable');
  const profile = `activation-${request.trialId}`;
  const env = {
    DISCORD_EXPECTED_BOT_ID: request.target.botId,
    DISCORD_DEFAULT_GUILD_ID: request.target.guildId,
    ALLOWED_GUILDS: request.target.guildId,
    MCP_TOOL_SURFACE: 'progressive',
    MCP_AUDIT_ENABLED: 'true',
    MCP_AUDIT_SINK: 'file',
    MCP_AUDIT_FILE: join(workspaceState.stateDirectory, 'audit.jsonl'),
    MCP_BLUEPRINT_STATE_DIR: workspaceState.stateDirectory,
    MCP_WRITE_MODE: 'allow',
    MCP_DRY_RUN: 'false',
  };
  return {
    mcpServers: {
      'discord-mcp': {
        command: 'npx',
        args: expectedServerArgs(request.release, profile),
        env,
      },
    },
  };
}

export function assertAntigravityCliConfigWritable(config, context = {}) {
  const parsed = parseConfig(config, 'Antigravity canonical config');
  assertSecretFree(parsed, context.request?.token, 'Antigravity canonical config');
  const expected = canonicalAllowConfig(context);
  if (JSON.stringify(parsed) !== JSON.stringify(expected))
    throw new Error('Antigravity canonical config is not exactly target-bound and write-enabled');
  return true;
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function builtInAuthPreflight(environment) {
  return async () => {
    assertAntigravityCliActivationAuthReady(environment);
  };
}

const defaultLiveAdapter = ({ environment, verifyRuntimePackage }) =>
  createAntigravityCliActivationLiveAdapter({ environment, verifyRuntimePackage });

export function createDefaultAntigravityCliActivationDependencies(options = {}) {
  if (!record(options)) throw new TypeError('Antigravity dependency options must be an object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Antigravity dependency options must not inherit activation seams');
  const runCommand = options.runCommand;
  const verifyProvenance = options.verifyProvenance;
  const resolveNpmCli = options.resolveNpmCli;
  const providedEnvironment = options.environment;
  const createLiveAdapter = options.createLiveAdapter;
  const environment = providedEnvironment ?? process.env;
  const usesOnlyBuiltIns =
    Reflect.ownKeys(options).length === 0 &&
    runCommand === undefined &&
    verifyProvenance === undefined &&
    resolveNpmCli === undefined &&
    providedEnvironment === undefined &&
    createLiveAdapter === undefined;
  const dependencies = createActivationDependencies({
    host: 'antigravity-cli',
    configFileName: 'mcp_config.json',
    runCommand,
    verifyProvenance,
    resolveNpmCli,
    environment,
    setupArgs: buildAntigravityCliSetupArgs,
    parseSetup: parseAntigravityCliSetupJson,
    assertConfigReady: assertAntigravityCliConfigReady,
    assertConfigWritable: assertAntigravityCliConfigWritable,
    enableWrites: async ({ configPath, request, workspaceState, install }) => {
      const config = canonicalAllowConfig({ request, workspaceState, install });
      await writeJsonAtomically(configPath, config);
      return { config };
    },
    buildEnvironment: ({ childEnvironment, profileRoot, profileEnvironmentKey, token }) => ({
      ...childEnvironment,
      [profileEnvironmentKey]: profileRoot,
      DISCORD_TOKEN: token,
    }),
    createLiveAdapter: createLiveAdapter ?? defaultLiveAdapter,
    executionProvenance: {
      execution_mode: 'live',
      adapter_id: 'discord-mcp.antigravity-cli-activation.v1',
      abortable: true,
      package_source: 'verified_npm_provenance',
    },
    authPreflight: builtInAuthPreflight(environment),
  });
  if (usesOnlyBuiltIns) TRUSTED_LIVE_DEPENDENCIES.add(dependencies);
  return dependencies;
}

export async function runAntigravityCliActivationTrial(options = {}) {
  const request = validateAntigravityCliActivationRequest(options);
  const dependencies = options.dependencies ?? createDefaultAntigravityCliActivationDependencies();
  const trusted = TRUSTED_LIVE_DEPENDENCIES.has(dependencies);
  if (trusted) await dependencies.authPreflight({ request });
  else if (request.executionMode === 'test') {
    const authPreflight = options.authPreflight ?? dependencies.authPreflight;
    if (typeof authPreflight === 'function') await authPreflight({ request });
  }
  return runActivationTrial({
    request,
    dependencies,
    clock: options.clock,
    host: 'antigravity-cli',
    limits: {
      phaseTimeoutMs: ANTIGRAVITY_CLI_ACTIVATION_PHASE_TIMEOUT_MS,
      recoveryTimeoutMs: ANTIGRAVITY_CLI_ACTIVATION_RECOVERY_TIMEOUT_MS,
      cancellationTimeoutMs: ANTIGRAVITY_CLI_ACTIVATION_CANCELLATION_TIMEOUT_MS,
    },
    assertConfigReady: assertAntigravityCliConfigReady,
    assertConfigWritable: assertAntigravityCliConfigWritable,
    buildLaunchEnvironment: ({ request: activationRequest }) => ({
      DISCORD_TOKEN: activationRequest.token,
      MCP_DRY_RUN: 'false',
      MCP_WRITE_MODE: 'allow',
    }),
    isTrustedLiveDependencies: (value) => TRUSTED_LIVE_DEPENDENCIES.has(value),
  });
}

export function parseAntigravityCliActivationArgs(argv) {
  if (!Array.isArray(argv))
    throw new TypeError('Antigravity activation arguments must be an array');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!ACTIVATION_CLI_FLAGS.has(flag) || Object.hasOwn(values, flag))
      throw new TypeError('invalid Antigravity activation arguments');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('invalid Antigravity activation arguments');
    values[flag] = value;
  }
  for (const flag of ACTIVATION_CLI_FLAGS)
    if (!Object.hasOwn(values, flag))
      throw new TypeError('invalid Antigravity activation arguments');
  if (!CONTROLLED_GUILD_IDS.includes(values['--guild']))
    throw new TypeError('invalid Antigravity activation arguments');
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
  if (!token) throw new Error('Antigravity activation environment is incomplete');
  return normalizeDiscordToken(token);
}

function activationCliFailure() {
  return {
    schema_version: 'discord-mcp.antigravity-cli-activation-cli.v1',
    ok: false,
    error: 'Antigravity activation trial failed',
  };
}

function writeSecretFreeCliResult(stdout, result, token) {
  const serialized = JSON.stringify(result);
  if (serialized.includes(token) || /GEMINI_API_KEY/iu.test(serialized)) {
    stdout.write(`${JSON.stringify(activationCliFailure())}\n`);
    return 1;
  }
  stdout.write(`${serialized}\n`);
  return result.ok ? 0 : 1;
}

export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  runTrial = runAntigravityCliActivationTrial,
} = {}) {
  try {
    const options = parseAntigravityCliActivationArgs(argv);
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
    return writeSecretFreeCliResult(stdout, result, token);
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
