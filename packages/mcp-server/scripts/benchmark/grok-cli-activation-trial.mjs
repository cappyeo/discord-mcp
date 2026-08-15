#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createActivationDependencies } from './activation-dependencies.mjs';
import { runActivationTrial } from './activation-trial.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { createGrokCliActivationLiveAdapter } from './grok-cli-activation-live-adapter.mjs';
import { renderGrokCliMcpConfig } from './grok-cli-driver.mjs';

export const GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX = 'APPROVE_GROK_CLI_ACTIVATION:';
export const GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX = 'APPROVE_GROK_CLI_ACTIVATION_WRITE:';
export const GROK_CLI_ACTIVATION_MAX_DURATION_MS = 600_000;
export const GROK_CLI_ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
export const GROK_CLI_ACTIVATION_RECOVERY_TIMEOUT_MS = 30_000;
export const GROK_CLI_ACTIVATION_CANCELLATION_TIMEOUT_MS = 5_000;

const SNOWFLAKE = /^\d{17,20}$/u;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const TRIAL = /^[a-z][a-z0-9._-]{2,63}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EXECUTION_MODES = new Set(['live', 'test']);
const XAI_API_KEY_MAX_BYTES = 4096;
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
  return `${GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX}${release}:${trialId}`;
}
function expectedWriteConfirmation(release, trialId) {
  return `${GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${release}:${trialId}`;
}

export function assertGrokCliActivationAuthReady(environment = process.env) {
  const value = environment?.XAI_API_KEY;
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    /[\r\n]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > XAI_API_KEY_MAX_BYTES
  )
    throw new Error('XAI_API_KEY preflight failed');
  return true;
}

function tomlValue(section, key, label) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'mu').exec(section);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new TypeError(`${label} must be generated Grok TOML`);
  }
}

function parseGrokToml(value, label) {
  const tables = new Map();
  let current = null;
  for (const line of value.split(/\r?\n/u)) {
    const table = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (table !== null) {
      current = table[1];
      if (!['mcp_servers.discord-mcp', 'mcp_servers.discord-mcp.env'].includes(current))
        throw new TypeError(`${label} must contain only the generated Grok MCP tables`);
      if (tables.has(current)) throw new TypeError(`${label} must be generated Grok TOML`);
      tables.set(current, '');
      continue;
    }
    if (current === null) {
      if (line.trim() !== '')
        throw new TypeError(`${label} must contain only the generated Grok MCP tables`);
      continue;
    }
    tables.set(current, `${tables.get(current)}${line}\n`);
  }
  const serverSection = tables.get('mcp_servers.discord-mcp');
  if (serverSection === undefined) throw new TypeError(`${label} must be generated Grok TOML`);
  const environmentSection = tables.get('mcp_servers.discord-mcp.env');
  const environment = {};
  if (environmentSection !== undefined) {
    for (const line of environmentSection.split(/\r?\n/u)) {
      const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/u.exec(line);
      if (assignment === null) {
        if (line.trim() !== '') throw new TypeError(`${label} must be generated Grok TOML`);
        continue;
      }
      try {
        environment[assignment[1]] = JSON.parse(assignment[2]);
      } catch {
        throw new TypeError(`${label} must be generated Grok TOML`);
      }
    }
  }
  const server = {
    command: tomlValue(serverSection, 'command', label),
    args: tomlValue(serverSection, 'args', label),
    enabled: tomlValue(serverSection, 'enabled', label),
    startup_timeout_sec: tomlValue(serverSection, 'startup_timeout_sec', label),
    tool_timeout_sec: tomlValue(serverSection, 'tool_timeout_sec', label),
    ...(environmentSection === undefined ? {} : { env: environment }),
  };
  return { mcp_servers: { 'discord-mcp': server } };
}

function parseConfig(value, label) {
  if (record(value)) return value;
  if (typeof value === 'string') return parseGrokToml(value, label);
  throw new TypeError(`${label} must be a Grok TOML document`);
}
function assertSecretFree(value, token, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (token && text.includes(token)) throw new Error(`${label} contains the Discord token`);
  if (/DISCORD_TOKEN|XAI_API_KEY|GROK_API_KEY|GROK_CODE_XAI_API_KEY/iu.test(text))
    throw new Error(`${label} contains a credential reference`);
}

export function validateGrokCliActivationRequest(options = {}) {
  if (!record(options)) throw new TypeError('Grok activation request must be an object');
  assertString(options.release, 'release', RELEASE);
  assertString(options.runId, 'runId', TRIAL);
  assertString(options.trialId, 'trialId', TRIAL);
  assertString(options.hostVersion, 'hostVersion', RELEASE);
  assertString(options.sourceCommit, 'sourceCommit', COMMIT);
  if (!record(options.target)) throw new TypeError('Grok controlled target is required');
  assertString(options.target.guildId, 'target.guildId', SNOWFLAKE);
  assertString(options.target.botId, 'target.botId', SNOWFLAKE);
  if (options.target.controlled !== true)
    throw new TypeError('Grok controlled target confirmation is required');
  if (options.target.callerOwned !== true)
    throw new TypeError('Grok caller-owned bot confirmation is required');
  const confirmation = options.operatorConfirmation ?? options.confirmation;
  if (confirmation !== expectedConfirmation(options.release, options.trialId))
    throw new TypeError('Grok operator confirmation does not match release and trial');
  const writeApproval = options.writeApproval ?? options.writeConfirmation;
  if (
    writeApproval !== undefined &&
    writeApproval !== expectedWriteConfirmation(options.release, options.trialId)
  )
    throw new TypeError('Grok write approval does not match release and trial');
  if (
    options.maxDurationMs !== undefined &&
    (!Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > GROK_CLI_ACTIVATION_MAX_DURATION_MS)
  )
    throw new TypeError('maxDurationMs must be between 1 and 600000');
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
    maxDurationMs: options.maxDurationMs ?? GROK_CLI_ACTIVATION_MAX_DURATION_MS,
    token,
    executionMode,
  };
}

export function buildGrokCliSetupArgs({ profile, guildId, configPath }) {
  assertString(profile, 'profile', TRIAL);
  assertString(guildId, 'guildId', SNOWFLAKE);
  if (typeof configPath !== 'string' || !isAbsolute(configPath))
    throw new TypeError('Grok configPath must be absolute');
  return [
    'setup',
    '--profile',
    profile,
    '--client',
    'grok-cli',
    '--allowed-guilds',
    guildId,
    '--output',
    configPath,
    '--force',
    '--json',
  ];
}

export function parseGrokCliSetupJson(stdout, target) {
  if (typeof stdout !== 'string' || stdout.trim() === '')
    throw new Error('Grok guided setup did not emit JSON output');
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error('Grok guided setup emitted invalid JSON output');
  }
  if (!record(output) || output.ok !== true || (output.exitCode ?? 0) !== 0)
    throw new Error('Grok guided setup JSON result was not successful');
  const botId = output.data?.discord?.bot?.id;
  const allowedGuilds = output.data?.allowedGuilds;
  if (
    !SNOWFLAKE.test(target.guildId ?? '') ||
    !SNOWFLAKE.test(target.botId ?? '') ||
    botId !== target.botId
  )
    throw new Error('Grok guided setup bot binding is invalid');
  if (
    !Array.isArray(allowedGuilds) ||
    allowedGuilds.length !== 1 ||
    allowedGuilds[0] !== target.guildId
  )
    throw new Error('Grok guided setup guild binding is invalid');
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

export function assertGrokCliConfigReady(config, { release, token, profile } = {}) {
  const parsed = parseConfig(config, 'Grok generated config');
  assertSecretFree(parsed, token, 'Grok generated config');
  const server = parsed.mcp_servers?.['discord-mcp'];
  if (
    Object.keys(parsed).length !== 1 ||
    !record(parsed.mcp_servers) ||
    Object.keys(parsed.mcp_servers).length !== 1 ||
    !record(server) ||
    server.enabled !== true ||
    server.command !== 'npx' ||
    JSON.stringify(server.args) !== JSON.stringify(expectedServerArgs(release, profile)) ||
    server.startup_timeout_sec !== 90 ||
    server.tool_timeout_sec !== 180 ||
    server.env !== undefined
  )
    throw new Error('Grok generated config is not pinned to the release and profile');
  return true;
}

function canonicalAllowConfig({ request, workspaceState, install }) {
  if (
    !record(request) ||
    !record(workspaceState) ||
    !record(install) ||
    !DIGEST.test(install.cliDigest ?? '')
  )
    throw new Error('Grok canonical config context is invalid');
  const profile = `activation-${request.trialId}`;
  return {
    mcp_servers: {
      'discord-mcp': {
        command: 'npx',
        args: expectedServerArgs(request.release, profile),
        enabled: true,
        startup_timeout_sec: 90,
        tool_timeout_sec: 180,
        env: {
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
        },
      },
    },
  };
}

export function assertGrokCliConfigWritable(config, context = {}) {
  const parsed = parseConfig(config, 'Grok canonical config');
  assertSecretFree(parsed, context.request?.token, 'Grok canonical config');
  if (JSON.stringify(parsed) !== JSON.stringify(canonicalAllowConfig(context)))
    throw new Error('Grok canonical config is not exactly target-bound and write-enabled');
  return true;
}

async function writeTomlAtomically(path, value) {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, renderGrokCliMcpConfig(value), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createDefaultGrokCliActivationDependencies(options = {}) {
  if (!record(options)) throw new TypeError('Grok dependency options must be an object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Grok dependency options must not inherit activation seams');
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
    host: 'grok-cli',
    configFileName: 'config.toml',
    runCommand,
    verifyProvenance,
    resolveNpmCli,
    environment,
    setupArgs: buildGrokCliSetupArgs,
    parseSetup: parseGrokCliSetupJson,
    assertConfigReady: assertGrokCliConfigReady,
    assertConfigWritable: assertGrokCliConfigWritable,
    enableWrites: async ({ configPath, request, workspaceState, install }) => {
      const config = canonicalAllowConfig({ request, workspaceState, install });
      await writeTomlAtomically(configPath, config);
      return { config };
    },
    buildEnvironment: ({ childEnvironment, home, profileRoot, profileEnvironmentKey, token }) => ({
      ...childEnvironment,
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: home,
      [profileEnvironmentKey]: profileRoot,
      DISCORD_TOKEN: token,
    }),
    createLiveAdapter:
      createLiveAdapter ??
      (({ environment: liveEnvironment, verifyRuntimePackage }) =>
        createGrokCliActivationLiveAdapter({ environment: liveEnvironment, verifyRuntimePackage })),
    executionProvenance: {
      execution_mode: 'live',
      adapter_id: 'discord-mcp.grok-cli-activation.v1',
      abortable: true,
      package_source: 'verified_npm_provenance',
    },
    authPreflight: async () => assertGrokCliActivationAuthReady(environment),
  });
  if (usesOnlyBuiltIns) TRUSTED_LIVE_DEPENDENCIES.add(dependencies);
  return dependencies;
}

export async function runGrokCliActivationTrial(options = {}) {
  const request = validateGrokCliActivationRequest(options);
  const dependencies = options.dependencies ?? createDefaultGrokCliActivationDependencies();
  if (TRUSTED_LIVE_DEPENDENCIES.has(dependencies) || request.executionMode === 'test')
    await dependencies.authPreflight?.({ request });
  return runActivationTrial({
    request,
    dependencies,
    clock: options.clock,
    host: 'grok-cli',
    limits: {
      phaseTimeoutMs: GROK_CLI_ACTIVATION_PHASE_TIMEOUT_MS,
      recoveryTimeoutMs: GROK_CLI_ACTIVATION_RECOVERY_TIMEOUT_MS,
      cancellationTimeoutMs: GROK_CLI_ACTIVATION_CANCELLATION_TIMEOUT_MS,
    },
    assertConfigReady: assertGrokCliConfigReady,
    assertConfigWritable: assertGrokCliConfigWritable,
    buildLaunchEnvironment: ({ request: activationRequest }) => ({
      DISCORD_TOKEN: activationRequest.token,
      MCP_DRY_RUN: 'false',
      MCP_WRITE_MODE: 'allow',
    }),
    isTrustedLiveDependencies: (value) => TRUSTED_LIVE_DEPENDENCIES.has(value),
  });
}

export function parseGrokCliActivationArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('Grok activation arguments must be an array');
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!ACTIVATION_CLI_FLAGS.has(flag) || Object.hasOwn(values, flag))
      throw new TypeError('invalid Grok activation arguments');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('invalid Grok activation arguments');
    values[flag] = value;
  }
  for (const flag of ACTIVATION_CLI_FLAGS)
    if (!Object.hasOwn(values, flag)) throw new TypeError('invalid Grok activation arguments');
  if (!CONTROLLED_GUILD_IDS.includes(values['--guild']))
    throw new TypeError('invalid Grok activation arguments');
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
  if (!token) throw new Error('Grok activation environment is incomplete');
  return normalizeDiscordToken(token);
}
function activationCliFailure() {
  return {
    schema_version: 'discord-mcp.grok-cli-activation-cli.v1',
    ok: false,
    error: 'Grok activation trial failed',
  };
}
function writeSecretFreeCliResult(stdout, result, token) {
  const serialized = JSON.stringify(result);
  if (serialized.includes(token) || /XAI_API_KEY|GROK_API_KEY/iu.test(serialized)) {
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
  runTrial = runGrokCliActivationTrial,
} = {}) {
  try {
    const options = parseGrokCliActivationArgs(argv);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then((code) => {
    process.exitCode = code;
  });
