#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivationDependencies } from './activation-dependencies.mjs';
import { runActivationTrial } from './activation-trial.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { createClaudeCodeActivationLiveAdapter } from './claude-code-activation-live-adapter.mjs';
import { buildClaudeCodeMcpConfig, validateClaudeCodeMcpConfig } from './claude-code-driver.mjs';

export const CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX = 'APPROVE_CLAUDE_CODE_ACTIVATION:';
export const CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX =
  'APPROVE_CLAUDE_CODE_ACTIVATION_WRITE:';
export const CLAUDE_CODE_ACTIVATION_MAX_DURATION_MS = 600_000;
export const CLAUDE_CODE_ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
export const CLAUDE_CODE_ACTIVATION_RECOVERY_TIMEOUT_MS = 30_000;
export const CLAUDE_CODE_ACTIVATION_CANCELLATION_TIMEOUT_MS = 5_000;
export const CLAUDE_CODE_ACTIVATION_PHASES = Object.freeze([
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
const ANTHROPIC_API_KEY_MAX_BYTES = 4096;
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
  return `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

function expectedWriteConfirmation(release, trialId) {
  return `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

function validateAnthropicApiKey(value) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value))
    throw new Error('ANTHROPIC_API_KEY preflight failed');
  if (Buffer.byteLength(value, 'utf8') > ANTHROPIC_API_KEY_MAX_BYTES)
    throw new Error('ANTHROPIC_API_KEY preflight failed');
  return value;
}

/** Validate Claude Code host authentication before campaign-local side effects. */
export function assertClaudeCodeActivationAuthReady(environment = process.env) {
  validateAnthropicApiKey(environment?.ANTHROPIC_API_KEY);
  return true;
}

function assertSecretFree(value, token, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (token && text.includes(token)) throw new Error(`${label} contains the Discord token`);
  if (text.includes('ANTHROPIC_API_KEY') || text.includes('anthropic_api_key'))
    throw new Error(`${label} contains an Anthropic secret reference`);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder must be rejected
  if (text.includes('${env:DISCORD_TOKEN}'))
    throw new Error(`${label} contains the legacy Discord token placeholder`);
}

function parseClaudeConfig(value, label) {
  if (record(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (record(parsed)) return parsed;
    } catch {
      // Report the same safe validation failure without echoing config content.
    }
  }
  throw new TypeError(`${label} must be a JSON object`);
}

/** Validate all operator-controlled identity and consent before host side effects. */
export function validateClaudeCodeActivationRequest(options = {}) {
  if (!record(options)) throw new TypeError('Claude Code activation request must be an object');
  assertString(options.release, 'release', RELEASE);
  assertString(options.runId, 'runId', TRIAL);
  assertString(options.trialId, 'trialId', TRIAL);
  assertString(options.hostVersion, 'hostVersion', RELEASE);
  assertString(options.sourceCommit, 'sourceCommit', COMMIT);
  if (!record(options.target)) throw new TypeError('Claude Code controlled target is required');
  assertString(options.target.guildId, 'target.guildId', SNOWFLAKE);
  assertString(options.target.botId, 'target.botId', SNOWFLAKE);
  if (options.target.controlled !== true)
    throw new TypeError('Claude Code controlled target confirmation is required');
  if (options.target.callerOwned !== true)
    throw new TypeError('Claude Code caller-owned bot confirmation is required');
  const confirmation = options.operatorConfirmation ?? options.confirmation;
  if (confirmation !== expectedConfirmation(options.release, options.trialId))
    throw new TypeError('Claude Code operator confirmation does not match release and trial');
  const writeApproval = options.writeApproval ?? options.writeConfirmation;
  if (
    writeApproval !== undefined &&
    writeApproval !== expectedWriteConfirmation(options.release, options.trialId)
  )
    throw new TypeError('Claude Code write approval does not match release and trial');
  if (options.maxDurationMs !== undefined) {
    if (
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > CLAUDE_CODE_ACTIVATION_MAX_DURATION_MS
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
    maxDurationMs: options.maxDurationMs ?? CLAUDE_CODE_ACTIVATION_MAX_DURATION_MS,
    token,
    executionMode,
  };
}

export function buildClaudeCodeSetupArgs({ profile, guildId, configPath }) {
  assertString(profile, 'profile', TRIAL);
  assertString(guildId, 'guildId', SNOWFLAKE);
  if (typeof configPath !== 'string' || !isAbsolute(configPath))
    throw new TypeError('Claude Code configPath must be absolute');
  return [
    'setup',
    '--profile',
    profile,
    '--client',
    'claude-code',
    '--allowed-guilds',
    guildId,
    '--output',
    configPath,
    '--force',
    '--json',
  ];
}

export function parseClaudeCodeSetupJson(stdout, target) {
  if (typeof stdout !== 'string' || stdout.trim() === '')
    throw new Error('Claude Code guided setup did not emit JSON output');
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error('Claude Code guided setup emitted invalid JSON output');
  }
  if (!record(output) || output.ok !== true || (output.exitCode ?? 0) !== 0)
    throw new Error('Claude Code guided setup JSON result was not successful');
  const botId = output.data?.discord?.bot?.id;
  const allowedGuilds = output.data?.allowedGuilds;
  if (
    !SNOWFLAKE.test(target.guildId ?? '') ||
    !SNOWFLAKE.test(target.botId ?? '') ||
    !SNOWFLAKE.test(botId ?? '') ||
    botId !== target.botId
  )
    throw new Error('Claude Code guided setup bot binding is invalid');
  if (
    !Array.isArray(allowedGuilds) ||
    allowedGuilds.length !== 1 ||
    allowedGuilds[0] !== target.guildId
  )
    throw new Error('Claude Code guided setup guild binding is invalid');
  return {
    binding: { guildId: target.guildId, botId },
    bindingVerified: true,
    setupOutput: output,
  };
}

export function assertClaudeCodeConfigReady(config, { release, token, profile } = {}) {
  config = parseClaudeConfig(config, 'Claude Code generated config');
  assertSecretFree(config, token, 'Claude Code generated config');
  const server = config.mcpServers?.['discord-mcp'];
  if (
    Object.keys(config).length !== 1 ||
    !record(config.mcpServers) ||
    Object.keys(config.mcpServers).length !== 1 ||
    !record(server)
  )
    throw new Error('Claude Code generated config must contain one discord-mcp server');
  if (typeof release !== 'string' || typeof profile !== 'string')
    throw new Error('Claude Code generated config binding is invalid');
  const expectedArgs = [
    '--yes',
    '--loglevel=error',
    `@discord-mcp/cli@${release}`,
    'serve',
    '--profile',
    profile,
  ];
  if (
    Object.keys(server).sort().join(',') !== 'args,command' ||
    server.command !== 'npx' ||
    !Array.isArray(server.args) ||
    JSON.stringify(server.args) !== JSON.stringify(expectedArgs)
  )
    throw new Error(
      'Claude Code generated config is not pinned to the requested release and profile command',
    );
  return true;
}

function installedCliPath(installRoot) {
  if (typeof installRoot !== 'string' || !isAbsolute(installRoot))
    throw new TypeError('Claude Code installRoot must be absolute');
  return resolve(join(installRoot, 'node_modules', '@discord-mcp', 'cli', 'dist', 'cli.js'));
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

function canonicalAllowConfig({ request, workspaceState, install }) {
  const cliPath = installedCliPath(workspaceState.installRoot);
  const config = buildClaudeCodeMcpConfig({
    nodePath: process.execPath,
    cliPath,
    target: request.target,
    stateDirectory: workspaceState.stateDirectory,
    mode: 'allow',
  });
  validateClaudeCodeMcpConfig(config, {
    nodePath: process.execPath,
    cliPath,
    target: request.target,
    stateDirectory: workspaceState.stateDirectory,
    mode: 'allow',
  });
  if (!record(install) || typeof install.cliDigest !== 'string')
    throw new Error('Claude Code install provenance is unavailable');
  return { config, cliPath };
}

export function assertClaudeCodeConfigWritable(config, context = {}) {
  const { request, workspaceState, install } = context;
  if (!record(request) || !record(workspaceState))
    throw new TypeError('Claude Code canonical config context is required');
  const { cliPath } = canonicalAllowConfig({ request, workspaceState, install });
  validateClaudeCodeMcpConfig(parseClaudeConfig(config, 'Claude Code canonical config'), {
    nodePath: process.execPath,
    cliPath,
    target: request.target,
    stateDirectory: workspaceState.stateDirectory,
    mode: 'allow',
  });
  return true;
}

function builtInAuthPreflight(environment) {
  return async () => {
    assertClaudeCodeActivationAuthReady(environment);
  };
}

const defaultLiveAdapter = ({ environment, verifyRuntimePackage }) =>
  createClaudeCodeActivationLiveAdapter({ environment, verifyRuntimePackage });

export function createDefaultClaudeCodeActivationDependencies(options = {}) {
  if (!record(options)) throw new TypeError('Claude Code dependency options must be an object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Claude Code dependency options must not inherit activation seams');
  const runCommand = options.runCommand;
  const verifyProvenance = options.verifyProvenance;
  const resolveNpmCli = options.resolveNpmCli;
  const providedEnvironment = options.environment;
  const createLiveAdapter = options.createLiveAdapter;
  const environment = providedEnvironment ?? process.env;
  const dependencies = createActivationDependencies({
    host: 'claude-code',
    configFileName: 'mcp.json',
    runCommand,
    verifyProvenance,
    resolveNpmCli,
    environment,
    setupArgs: buildClaudeCodeSetupArgs,
    parseSetup: parseClaudeCodeSetupJson,
    assertConfigReady: assertClaudeCodeConfigReady,
    assertConfigWritable: assertClaudeCodeConfigWritable,
    enableWrites: async ({ configPath, request, workspaceState, install }) => {
      const { config } = canonicalAllowConfig({ request, workspaceState, install });
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
      adapter_id: 'discord-mcp.claude-code-activation.v1',
      abortable: true,
      package_source: 'verified_npm_provenance',
    },
    authPreflight: builtInAuthPreflight(environment),
  });
  if (
    Reflect.ownKeys(options).length === 0 &&
    runCommand === undefined &&
    verifyProvenance === undefined &&
    resolveNpmCli === undefined &&
    providedEnvironment === undefined &&
    createLiveAdapter === undefined
  )
    TRUSTED_LIVE_DEPENDENCIES.add(dependencies);
  return dependencies;
}

export async function runClaudeCodeActivationTrial(options = {}) {
  const request = validateClaudeCodeActivationRequest(options);
  const dependencies = options.dependencies ?? createDefaultClaudeCodeActivationDependencies();
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
    host: 'claude-code',
    limits: {
      phaseTimeoutMs: CLAUDE_CODE_ACTIVATION_PHASE_TIMEOUT_MS,
      recoveryTimeoutMs: CLAUDE_CODE_ACTIVATION_RECOVERY_TIMEOUT_MS,
      cancellationTimeoutMs: CLAUDE_CODE_ACTIVATION_CANCELLATION_TIMEOUT_MS,
    },
    assertConfigReady: assertClaudeCodeConfigReady,
    assertConfigWritable: assertClaudeCodeConfigWritable,
    buildLaunchEnvironment: ({ request: activationRequest }) => ({
      DISCORD_TOKEN: activationRequest.token,
      MCP_DRY_RUN: 'false',
      MCP_WRITE_MODE: 'allow',
    }),
    isTrustedLiveDependencies: (value) => TRUSTED_LIVE_DEPENDENCIES.has(value),
  });
}

export function parseClaudeCodeActivationArgs(argv) {
  if (!Array.isArray(argv))
    throw new TypeError('Claude Code activation arguments must be an array');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!ACTIVATION_CLI_FLAGS.has(flag) || Object.hasOwn(values, flag))
      throw new TypeError('invalid Claude Code activation arguments');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('invalid Claude Code activation arguments');
    values[flag] = value;
  }
  for (const flag of ACTIVATION_CLI_FLAGS)
    if (!Object.hasOwn(values, flag))
      throw new TypeError('invalid Claude Code activation arguments');
  if (!CONTROLLED_GUILD_IDS.includes(values['--guild']))
    throw new TypeError('invalid Claude Code activation arguments');
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
  if (!token) throw new Error('Claude Code activation environment is incomplete');
  return normalizeDiscordToken(token);
}

function activationCliFailure() {
  return {
    schema_version: 'discord-mcp.claude-code-activation-cli.v1',
    ok: false,
    error: 'Claude Code activation trial failed',
  };
}

function writeSecretFreeCliResult(stdout, result, token) {
  const serialized = JSON.stringify(result);
  if (
    serialized.includes(token) ||
    serialized.includes('ANTHROPIC_API_KEY') ||
    serialized.includes('anthropic_api_key')
  ) {
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
  runTrial = runClaudeCodeActivationTrial,
} = {}) {
  try {
    const options = parseClaudeCodeActivationArgs(argv);
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
