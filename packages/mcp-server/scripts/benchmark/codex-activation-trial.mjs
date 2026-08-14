#!/usr/bin/env node

import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

import { activationTrialDigest, createActivationTrialArtifact } from './activation-artifact.mjs';
import {
  canonicalActivationAttestationDigest,
  canonicalActivationEvidenceDigest,
  createActivationAttestation,
  verifyActivationAttestation,
} from './activation-attestation.mjs';
import { createCodexActivationLiveAdapter } from './codex-activation-live-adapter.mjs';
import { sameFileIdentity } from './file-identity.mjs';
import {
  createNpmAuditEnvironment,
  NPM_REGISTRY_URL,
  resolveTrustedNpmCli,
  verifyInstalledNpmProvenance,
} from './npm-provenance.mjs';

const execFile = promisify(nodeExecFile);

export const CODEX_ACTIVATION_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION:';
export const CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX = 'APPROVE_CODEX_ACTIVATION_WRITE:';
export const CODEX_ACTIVATION_MAX_DURATION_MS = 600_000;
export const CODEX_ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
export const CODEX_ACTIVATION_RECOVERY_TIMEOUT_MS = 30_000;
export const CODEX_ACTIVATION_CANCELLATION_TIMEOUT_MS = 5_000;
export const CODEX_ACTIVATION_MAX_BUFFER = 10 * 1024 * 1024;
const CODEX_ACTIVATION_MAX_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const CODEX_ACTIVATION_MAX_PACKAGE_TREE_BYTES = 128 * 1024 * 1024;
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
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ADAPTER_ID = /^[a-z][a-z0-9._-]{2,63}$/;
const APPLY_SUCCESS = new Set(['complete', 'already_current']);
const EXECUTION_MODES = new Set(['live', 'test']);
const TRUSTED_LIVE_DEPENDENCIES = new WeakSet();
const EXECUTION_PROVENANCE_KEYS = ['abortable', 'adapter_id', 'execution_mode', 'package_source'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExecutionProvenance(value, executionMode) {
  if (!record(value)) throw new TypeError('dependency executionProvenance is required');
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXECUTION_PROVENANCE_KEYS.length ||
    keys.some((key, index) => key !== EXECUTION_PROVENANCE_KEYS[index])
  )
    throw new TypeError('dependency executionProvenance has invalid keys');
  if (value.execution_mode !== executionMode)
    throw new TypeError('dependency execution mode does not match the request');
  if (typeof value.adapter_id !== 'string' || !ADAPTER_ID.test(value.adapter_id))
    throw new TypeError('dependency adapter id is invalid');
  if (value.abortable !== true) throw new TypeError('dependency adapter must support cancellation');
  const expectedPackageSource =
    executionMode === 'live' ? 'verified_npm_provenance' : 'test_fixture';
  if (value.package_source !== expectedPackageSource)
    throw new TypeError('dependency package source does not match the execution mode');
  return { ...value };
}

function assertString(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
}

function digest(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
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

async function defaultRunCommand(command, args, options) {
  return execFile(command, args, options);
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
  if (!SNOWFLAKE.test(botId ?? '') || botId !== target.botId)
    throw new Error('guided setup authenticated bot does not match the target bot');
  if (
    !Array.isArray(allowedGuilds) ||
    !allowedGuilds.every((guildId) => typeof guildId === 'string' && SNOWFLAKE.test(guildId)) ||
    !allowedGuilds.includes(target.guildId)
  )
    throw new Error('guided setup allowed guilds do not include the target guild');
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

function defaultWorkspace() {
  return {
    async create({ trialId }) {
      const root = await mkdtemp(join(tmpdir(), `discord-mcp-codex-${trialId}-`));
      const home = join(root, 'codex-home');
      const installRoot = join(root, 'public-install');
      const profileRoot = join(root, process.platform === 'win32' ? 'appdata' : 'xdg-config');
      const stateDirectory = join(root, 'blueprint-state');
      await mkdir(home, { recursive: true });
      await mkdir(installRoot, { recursive: true });
      await mkdir(profileRoot, { recursive: true });
      await mkdir(stateDirectory, { recursive: true });
      return {
        root,
        home,
        installRoot,
        profileRoot,
        profileEnvironmentKey: profileEnvironmentKey(),
        configPath: join(home, 'config.toml'),
        stateDirectory,
        cleanProfile: true,
      };
    },
    readText: (path) => readFile(path, 'utf8'),
    writeText: (path, value) => writeFile(path, value, 'utf8'),
    async remove(path) {
      await rm(path, { recursive: true, force: true });
      try {
        await stat(path);
        return { removed: false, verified: false };
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: true, verified: true };
        throw error;
      }
    },
  };
}

/**
 * Public package adapter. Install, guided setup, Codex execution, Discord
 * readback, and restoration are real and disposable. Arbitrary injected
 * adapters still cannot mint authoritative live evidence.
 */
export function createDefaultCodexActivationDependencies(options = {}) {
  if (!record(options)) throw new TypeError('dependency options must be an object');
  const {
    runCommand = defaultRunCommand,
    verifyProvenance = verifyInstalledNpmProvenance,
    environment = process.env,
    resolveNpmCli = resolveTrustedNpmCli,
  } = options;
  const usesOnlyBuiltIns =
    runCommand === defaultRunCommand &&
    verifyProvenance === verifyInstalledNpmProvenance &&
    environment === process.env &&
    resolveNpmCli === resolveTrustedNpmCli;
  const workspace = defaultWorkspace();
  const childEnvironment = createNpmAuditEnvironment({
    env: environment,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });
  const liveAdapter = createCodexActivationLiveAdapter({
    environment,
    verifyRuntimePackage: async ({ installRoot, install }) => {
      if (
        !record(install) ||
        !DIGEST.test(install.cliDigest ?? '') ||
        !DIGEST.test(install.coreDigest ?? '')
      ) {
        throw new Error('installed runtime provenance is unavailable');
      }
      const cliRoot = join(installRoot, 'node_modules', '@discord-mcp', 'cli');
      const coreRoot = join(installRoot, 'node_modules', '@discord-mcp', 'core');
      const [cliDigest, coreDigest] = await Promise.all([hashTree(cliRoot), hashTree(coreRoot)]);
      if (cliDigest !== install.cliDigest || coreDigest !== install.coreDigest)
        throw new Error('installed runtime changed after provenance verification');
      return {
        cliPath: join(cliRoot, 'dist', 'cli.js'),
        corePath: join(coreRoot, 'dist', 'index.js'),
      };
    },
  });
  const dependencies = {
    workspace: Object.freeze(workspace),
    executionProvenance: Object.freeze({
      execution_mode: 'live',
      adapter_id: 'discord-mcp.codex-activation.v1',
      abortable: true,
      package_source: 'verified_npm_provenance',
    }),
    async install({ release, sourceCommit, installRoot, signal }) {
      const packageSpec = `@discord-mcp/cli@${release}`;
      const npmCliPath = await resolveNpmCli({
        execPath: process.execPath,
        platform: process.platform,
      });
      const result = await runCommand(
        process.execPath,
        [
          npmCliPath,
          'install',
          '--prefix',
          installRoot,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          `--registry=${NPM_REGISTRY_URL}`,
          packageSpec,
        ],
        {
          cwd: installRoot,
          env: childEnvironment,
          timeout: CODEX_ACTIVATION_PHASE_TIMEOUT_MS,
          maxBuffer: CODEX_ACTIVATION_MAX_BUFFER,
          windowsHide: true,
          signal,
        },
      );
      if ((result.code ?? result.exitCode ?? 0) !== 0)
        throw new Error('public package install failed');
      const cliRoot = join(installRoot, 'node_modules', '@discord-mcp', 'cli');
      const coreRoot = join(installRoot, 'node_modules', '@discord-mcp', 'core');
      const cliProvenance = await verifyProvenance({
        installRoot,
        packageName: '@discord-mcp/cli',
        release,
        expectedCommit: sourceCommit,
        runCommand,
        env: childEnvironment,
        signal,
        nodeExecPath: process.execPath,
        resolveNpmCli: async () => npmCliPath,
      });
      const coreProvenance = await verifyProvenance({
        installRoot,
        packageName: '@discord-mcp/core',
        release,
        expectedCommit: sourceCommit,
        runCommand,
        env: childEnvironment,
        signal,
        nodeExecPath: process.execPath,
        resolveNpmCli: async () => npmCliPath,
      });
      if (
        cliProvenance?.sourceCommit !== sourceCommit ||
        coreProvenance?.sourceCommit !== sourceCommit
      )
        throw new Error('public package provenance source commit mismatch');
      const cliDigest = await hashTree(cliRoot);
      const coreDigest = await hashTree(coreRoot);
      return {
        packageSpec,
        sourceCommit,
        cliDigest,
        coreDigest,
        packageDigest: digest({
          schema_version: 'discord-mcp.activation-package.v1',
          release,
          source_commit: sourceCommit,
          cli_digest: cliDigest,
          core_digest: coreDigest,
          cli_registry_integrity: cliProvenance.registryIntegrityDigest,
          core_registry_integrity: coreProvenance.registryIntegrityDigest,
        }),
      };
    },
    async setup({
      release,
      profile,
      target,
      configPath,
      home,
      profileRoot,
      installRoot,
      token,
      signal,
    }) {
      const entrypoint = join(installRoot, 'node_modules', '@discord-mcp', 'cli', 'dist', 'cli.js');
      const result = await runCommand(
        process.execPath,
        [entrypoint, ...buildCodexSetupArgs({ profile, guildId: target.guildId, configPath })],
        {
          cwd: installRoot,
          env: {
            ...childEnvironment,
            CODEX_HOME: home,
            [profileEnvironmentKey()]: profileEnvironmentValue(profileRoot),
            DISCORD_TOKEN: token,
          },
          timeout: CODEX_ACTIVATION_PHASE_TIMEOUT_MS,
          maxBuffer: CODEX_ACTIVATION_MAX_BUFFER,
          windowsHide: true,
          signal,
        },
      );
      const config = await readFile(configPath, 'utf8').catch(() => '');
      let verified;
      try {
        verified = parseGuidedSetupJson(result.stdout ?? '', target);
      } catch (error) {
        if (
          /administrator/i.test(result.stdout ?? '') ||
          /administrator/i.test(result.stderr ?? '')
        )
          error.administratorWarning = true;
        throw error;
      }
      return {
        exitCode: result.code ?? result.exitCode ?? 0,
        administratorWarning:
          /administrator/i.test(result.stdout ?? '') || /administrator/i.test(result.stderr ?? ''),
        config,
        release,
        profileRoot,
        ...verified,
      };
    },
    async enableWrites({ configPath, config }) {
      const updated = `${config.trimEnd()}\n\n[mcp_servers.discord-mcp.env]\nMCP_DRY_RUN = "false"\nMCP_WRITE_MODE = "allow"\n`;
      await writeFile(configPath, updated, 'utf8');
      return { config: updated };
    },
    ...liveAdapter,
  };
  Object.freeze(dependencies);
  if (usesOnlyBuiltIns) TRUSTED_LIVE_DEPENDENCIES.add(dependencies);
  return dependencies;
}

function profileEnvironmentKey() {
  return process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
}

function profileEnvironmentValue(profileRoot) {
  return profileRoot;
}

async function readPackageFile(path) {
  const initial = await lstat(path);
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size > CODEX_ACTIVATION_MAX_PACKAGE_FILE_BYTES
  )
    throw new Error('installed package contains an invalid file');
  const flags =
    fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle;
  try {
    handle = await open(path, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.size !== initial.size || !sameFileIdentity(initial, before))
      throw new Error('installed package changed while hashing');
    const openedPath = await lstat(path);
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.size !== initial.size ||
      openedPath.dev !== initial.dev ||
      openedPath.ino !== initial.ino
    )
      throw new Error('installed package changed while hashing');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new Error('installed package changed while hashing');
    const finalPath = await lstat(path);
    if (
      finalPath.isSymbolicLink() ||
      !finalPath.isFile() ||
      finalPath.size !== initial.size ||
      finalPath.dev !== initial.dev ||
      finalPath.ino !== initial.ino
    )
      throw new Error('installed package changed while hashing');
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function hashTree(root) {
  const files = [];
  let totalBytes = 0;
  const compareCodePoints = (left, right) => {
    const leftPoints = Array.from(left);
    const rightPoints = Array.from(right);
    const length = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < length; index += 1) {
      const leftCodePoint = leftPoints[index].codePointAt(0);
      const rightCodePoint = rightPoints[index].codePointAt(0);
      if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
    }
    return leftPoints.length - rightPoints.length;
  };
  const assertSameDirectory = (before, after) => {
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new Error('installed package directory changed while hashing');
  };
  async function visit(directory, relative = '') {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
      throw new Error('installed package contains an invalid directory');
    const entries = await readdir(directory, { withFileTypes: true });
    assertSameDirectory(directoryStat, await lstat(directory));
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      const entryRelative = relative ? join(relative, entry.name) : entry.name;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath, entryRelative);
      else if (entry.isFile()) {
        const bytes = await readPackageFile(entryPath);
        totalBytes += bytes.length;
        if (totalBytes > CODEX_ACTIVATION_MAX_PACKAGE_TREE_BYTES)
          throw new Error('installed package exceeds the tree size bound');
        files.push({ path: entryRelative, bytes });
      } else {
        throw new Error('installed package contains an unsupported entry');
      }
    }
    assertSameDirectory(directoryStat, await lstat(directory));
  }
  await visit(root);
  if (files.length === 0) throw new Error('installed package contains no files');
  const hash = createHash('sha256');
  for (const file of files)
    hash.update(file.path.split(sep).join('/')).update('\0').update(file.bytes).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function bindingMatches(value, target) {
  const binding = value?.binding ?? value?.target ?? value;
  return binding?.guildId === target.guildId && binding?.botId === target.botId;
}

function hasReportedBinding(value) {
  if (!record(value)) return false;
  const binding = value.binding ?? value.target ?? value;
  return record(binding) && ('guildId' in binding || 'botId' in binding);
}

function lifecycleCloseSettled(value) {
  return (
    record(value) && (value.settled === true || value.closed === true || value.terminated === true)
  );
}

function readinessOf(value) {
  if (value === true || value === 'ready') return 'ready';
  if (value === 'blocked') return 'blocked';
  return 'failed';
}

function evidenceOf(value) {
  if (value === 'verified' || value?.status === 'verified') return 'verified';
  if (value === 'blocked' || value?.status === 'blocked') return 'blocked';
  return 'failed';
}

function applyOf(value) {
  const status = value?.status ?? value;
  if (APPLY_SUCCESS.has(status)) return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}

function safeClock(clock) {
  const now = clock?.now ?? (() => performance.now());
  if (typeof now !== 'function') throw new TypeError('clock.now must be a function');
  let previous = Number.NEGATIVE_INFINITY;
  return () => {
    const value = Number(now());
    if (!Number.isFinite(value) || value < previous) throw new Error('clock is not monotonic');
    previous = value;
    return value;
  };
}

class PhaseTimeoutError extends Error {
  constructor(name) {
    super(`${name} phase timed out`);
    this.name = 'PhaseTimeoutError';
  }
}

/**
 * Run one clean Codex activation trial. Adapter failures become a failed,
 * secret-free artifact; request validation errors happen before any side
 * effect. Baseline restoration is attempted in a finally block on every
 * operational failure.
 */
export async function runCodexActivationTrial(options = {}) {
  const request = validateCodexActivationRequest(options);
  const dependencies = options.dependencies ?? createDefaultCodexActivationDependencies();
  const required = [
    'install',
    'setup',
    'enableWrites',
    'launch',
    'apply',
    'evidence',
    'captureBaseline',
    'restoreBaseline',
    'verifyBaseline',
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== 'function')
      throw new TypeError(`dependency ${name} is required`);
  }
  const workspace = dependencies.workspace ?? defaultWorkspace();
  for (const name of ['create', 'readText', 'writeText', 'remove']) {
    if (typeof workspace[name] !== 'function') throw new TypeError(`workspace.${name} is required`);
  }
  const closeSession = dependencies.closeSession ?? dependencies.terminate;
  if (request.executionMode === 'live' && typeof closeSession !== 'function')
    throw new TypeError('live execution requires closeSession or terminate lifecycle seam');
  const executionProvenance = assertExecutionProvenance(
    dependencies.executionProvenance,
    request.executionMode,
  );
  if (request.executionMode === 'live' && !TRUSTED_LIVE_DEPENDENCIES.has(dependencies))
    throw new TypeError('live execution requires the built-in audited dependency adapter');
  const now = safeClock(options.clock);
  const started = now();
  const durations = Object.fromEntries(CODEX_ACTIVATION_PHASES.map((phase) => [phase, 0]));
  const readiness = {
    install: 'blocked',
    setup: 'blocked',
    client: 'blocked',
    first_request: 'blocked',
  };
  const evidence = { apply: 'blocked', guild_blueprint_evidence: 'blocked' };
  let dangerousPermissions = false;
  let bindingVerified = false;
  const callerOwnedBot = request.target.callerOwned === true;
  let cleanProfile = false;
  let cleanupVerified = false;
  let isolatedSession = false;
  let failure = false;
  let timedOut = false;
  let unsettledOperation = false;
  let baseline = null;
  let baselineCaptured = false;
  let workspaceState = null;
  let installResult = null;
  let session = null;
  let activityEvidence = null;
  let activityEvidenceValidated = false;
  let configDigest = digest('config-unavailable');
  let buildDigests = null;
  let beforeDigest = digest('baseline-unavailable-before');
  let afterDigest = digest('baseline-unavailable-after');
  let buildDigest = digest(`@discord-mcp/cli@${request.release}`);
  let evidenceDigest = digest('evidence-unavailable');
  let sessionDigest = digest('session-unavailable');
  let launchInvoked = false;
  let sessionRegistered = false;

  const registerSession = (handle) => {
    if (!record(handle)) throw new TypeError('launch session handle must be an object');
    if (session !== null && session !== handle)
      throw new Error('launch attempted to replace its registered session handle');
    session = handle;
    sessionRegistered = true;
    return handle;
  };
  let sessionClosed = false;

  const markTotal = () => {
    const elapsed = now() - started;
    durations.total = elapsed;
    if (!Number.isSafeInteger(Math.round(elapsed)) || elapsed < 0) failure = true;
    if (elapsed >= request.maxDurationMs) {
      failure = true;
      timedOut = true;
    }
    durations.total = Math.max(0, Math.round(elapsed));
  };

  const waitForCancellation = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), CODEX_ACTIVATION_CANCELLATION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const phase = async (name, fn, { recovery = false } = {}) => {
    if (failure && name !== 'restore') return null;
    const begin = now();
    const controller = new AbortController();
    const remaining = request.maxDurationMs - (begin - started);
    const timeoutMs = recovery
      ? CODEX_ACTIVATION_RECOVERY_TIMEOUT_MS
      : Math.max(1, Math.min(CODEX_ACTIVATION_PHASE_TIMEOUT_MS, remaining));
    let timer;
    let operation;
    let timeoutTriggered = false;
    try {
      operation = Promise.resolve().then(() => fn({ signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timeoutTriggered = true;
          controller.abort();
          reject(new PhaseTimeoutError(name));
        }, timeoutMs);
      });
      const value = await Promise.race([operation, timeout]);
      const elapsed = now() - begin;
      if (elapsed < 0 || elapsed >= request.maxDurationMs) {
        failure = true;
        timedOut = true;
      }
      durations[name] = Math.max(0, Math.round(elapsed));
      return value;
    } catch (error) {
      failure = true;
      if (error?.administratorWarning === true) dangerousPermissions = true;
      if (timeoutTriggered || error instanceof PhaseTimeoutError) {
        timedOut = true;
        controller.abort();
        if (operation && !(await waitForCancellation(operation))) unsettledOperation = true;
      }
      durations[name] = Math.max(0, Math.round(now() - begin));
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const boundedCall = async (name, fn, { recovery = false } = {}) => {
    const begin = now();
    const controller = new AbortController();
    const remaining = request.maxDurationMs - (begin - started);
    const timeoutMs = recovery
      ? CODEX_ACTIVATION_RECOVERY_TIMEOUT_MS
      : Math.max(1, Math.min(CODEX_ACTIVATION_PHASE_TIMEOUT_MS, remaining));
    let timer;
    let operation;
    let timeoutTriggered = false;
    try {
      operation = Promise.resolve().then(() => fn({ signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timeoutTriggered = true;
          controller.abort();
          reject(new PhaseTimeoutError(name));
        }, timeoutMs);
      });
      return await Promise.race([operation, timeout]);
    } catch (error) {
      failure = true;
      if (timeoutTriggered || error instanceof PhaseTimeoutError) {
        timedOut = true;
        controller.abort();
        if (operation && !(await waitForCancellation(operation))) unsettledOperation = true;
      }
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    workspaceState = await boundedCall('workspace.create', ({ signal }) =>
      workspace.create({ trialId: request.trialId, signal }),
    );
    baseline = await boundedCall('captureBaseline', ({ signal }) =>
      dependencies.captureBaseline({
        target: request.target,
        token: request.token,
        runId: request.runId,
        trialId: request.trialId,
        sourceCommit: request.sourceCommit,
        signal,
      }),
    );
    const capturedDigest = baseline?.beforeDigest ?? baseline?.digest;
    if (!record(baseline) || !DIGEST.test(capturedDigest ?? '')) {
      baseline = null;
      failure = true;
    } else {
      baselineCaptured = true;
      beforeDigest = capturedDigest;
    }

    installResult = await phase('install', async ({ signal }) => {
      const result = await dependencies.install({
        release: request.release,
        sourceCommit: request.sourceCommit,
        installRoot: workspaceState.installRoot,
        target: request.target,
        signal,
      });
      if (result?.sourceCommit !== request.sourceCommit)
        throw new Error('installed package source commit mismatch');
      if (result?.hostVersion !== undefined && result.hostVersion !== request.hostVersion)
        throw new Error('Codex host version mismatch');
      return result;
    });
    readiness.install = installResult ? 'ready' : 'failed';
    if (installResult) {
      buildDigests = {
        cli_digest: installResult.cliDigest,
        core_digest: installResult.coreDigest,
        package_digest: installResult.packageDigest,
      };
      if (
        !DIGEST.test(buildDigests.cli_digest ?? '') ||
        !DIGEST.test(buildDigests.core_digest ?? '') ||
        !DIGEST.test(buildDigests.package_digest ?? '')
      ) {
        failure = true;
      } else {
        buildDigest = buildDigests.package_digest;
      }
    }
    cleanProfile = workspaceState?.cleanProfile === true;

    const profile = `activation-${request.trialId}`;
    const setup = await phase('setup', async ({ signal }) => {
      const result = await dependencies.setup({
        release: request.release,
        profile,
        target: request.target,
        configPath: workspaceState.configPath,
        profileRoot: workspaceState.profileRoot,
        profileEnvironmentKey: workspaceState.profileEnvironmentKey ?? profileEnvironmentKey(),
        home: workspaceState.home,
        installRoot: workspaceState.installRoot,
        token: request.token,
        signal,
      });
      if (result?.administratorWarning === true) dangerousPermissions = true;
      if ((result?.exitCode ?? 0) !== 0 || result?.administratorWarning === true)
        throw new Error('guided setup failed safety checks');
      if (result?.bindingVerified !== true || !bindingMatches(result?.binding, request.target))
        throw new Error('guided setup binding proof is missing or mismatched');
      bindingVerified = true;
      const config = result?.config ?? (await workspace.readText(workspaceState.configPath));
      assertCodexConfigReady(config, { release: request.release, token: request.token });
      return { ...result, config };
    });
    readiness.setup = setup ? 'ready' : 'failed';

    if (setup && request.writeApproval !== undefined) {
      const client = await phase('client_ready', async ({ signal }) => {
        const result = await dependencies.enableWrites({
          configPath: workspaceState.configPath,
          config: setup.config,
          approval: request.writeApproval,
          signal,
        });
        const config = result?.config ?? (await workspace.readText(workspaceState.configPath));
        assertCodexConfigWritable(config);
        configDigest = digest(config);
        launchInvoked = true;
        const launched = await dependencies.launch({
          release: request.release,
          target: request.target,
          home: workspaceState.home,
          configPath: workspaceState.configPath,
          profileRoot: workspaceState.profileRoot,
          profileEnvironmentKey: workspaceState.profileEnvironmentKey ?? profileEnvironmentKey(),
          installRoot: workspaceState.installRoot,
          install: installResult,
          hostVersion: request.hostVersion,
          stateDirectory: workspaceState.stateDirectory,
          env: {
            CODEX_HOME: workspaceState.home,
            [workspaceState.profileEnvironmentKey ?? profileEnvironmentKey()]:
              workspaceState.profileRoot,
            DISCORD_TOKEN: request.token,
            MCP_DRY_RUN: 'false',
            MCP_WRITE_MODE: 'allow',
          },
          binding: setup.binding,
          // A live adapter must call this before it starts a process/client so
          // rejection or timeout can never hide a running session from cleanup.
          registerSession,
          signal,
        });
        if (request.executionMode === 'live' && !sessionRegistered)
          throw new Error('live launch did not register its session before returning');
        if (!sessionRegistered) registerSession(launched);
        else if (launched !== undefined && launched !== session)
          throw new Error('launch returned a different session than it registered');
        return { enabled: { ...result, config }, launched: session };
      });
      if (!client && launchInvoked && session === null) unsettledOperation = true;
      if (client) {
        const launched = client.launched;
        session = launched;
        isolatedSession = launched?.isolated === true;
        readiness.client = readinessOf(launched?.clientReady ?? launched?.ready);
        if (!DIGEST.test(launched?.sessionDigest ?? '')) {
          failure = true;
          readiness.client = 'failed';
        } else {
          sessionDigest = launched.sessionDigest;
        }
        const first = await phase('first_request', async ({ signal }) => {
          if (!launched || readiness.client !== 'ready')
            throw new Error('Codex client is not ready');
          if (launched.firstRequest !== true && launched.firstRequestStatus !== 'ready')
            throw new Error('Codex first request did not complete');
          if (hasReportedBinding(launched) && !bindingMatches(launched, request.target))
            throw new Error('launch target binding mismatch');
          if (signal.aborted) throw new PhaseTimeoutError('first_request');
          return launched;
        });
        readiness.first_request = first ? 'ready' : 'failed';
        const applied = await phase('apply', async ({ signal }) => {
          if (!first) throw new Error('first request failed');
          const result = await dependencies.apply({
            session,
            target: request.target,
            binding: setup.binding,
            signal,
          });
          if (hasReportedBinding(result) && !bindingMatches(result, request.target))
            throw new Error('apply result binding is invalid');
          if (!APPLY_SUCCESS.has(result?.status))
            throw new Error('apply result binding or status is invalid');
          return result;
        });
        evidence.apply = applyOf(applied?.status);
        const verified = await phase('evidence', async ({ signal }) => {
          if (!applied) throw new Error('apply was not complete');
          const result = await dependencies.evidence({
            session,
            target: request.target,
            apply: applied,
            binding: setup.binding,
            signal,
          });
          if (!bindingMatches(result, request.target) || evidenceOf(result) !== 'verified')
            throw new Error('separate guild blueprint evidence is not verified');
          activityEvidence = result?.activityEvidence ?? result?.activity_evidence;
          if (!activityEvidence || typeof activityEvidence !== 'object')
            throw new Error('full Activity Evidence record is required');
          if (
            activityEvidence.target?.guild_id !== request.target.guildId ||
            activityEvidence.target?.bot_id !== request.target.botId
          )
            throw new Error('Activity Evidence target binding mismatch');
          if (typeof dependencies.validateActivityEvidence !== 'function')
            throw new Error('Activity Evidence validator is required');
          const valid = await dependencies.validateActivityEvidence(activityEvidence, {
            session,
            signal,
          });
          if (valid === false) throw new Error('Activity Evidence validation failed');
          activityEvidenceValidated = true;
          return result;
        });
        evidence.guild_blueprint_evidence = evidenceOf(verified);
        evidenceDigest = activityEvidence?.evidence_id ?? digest('evidence-unavailable');
        if (!DIGEST.test(evidenceDigest)) throw new Error('Activity Evidence digest is invalid');
      }
    } else {
      failure = true;
      readiness.client = 'blocked';
      readiness.first_request = 'blocked';
    }
  } catch {
    failure = true;
  } finally {
    if (session !== null && session !== undefined) {
      if (typeof closeSession !== 'function') {
        failure = true;
        unsettledOperation = true;
      } else {
        const closed = await boundedCall(
          'closeSession',
          ({ signal }) => closeSession({ session, target: request.target, signal }),
          { recovery: true },
        );
        sessionClosed = lifecycleCloseSettled(closed);
        if (!sessionClosed) {
          failure = true;
          unsettledOperation = true;
        }
      }
    }
    if (baselineCaptured && !unsettledOperation)
      await phase(
        'restore',
        async ({ signal }) => {
          const restored = await dependencies.restoreBaseline({
            target: request.target,
            baseline,
            session,
            signal,
          });
          const verification = await dependencies.verifyBaseline({
            target: request.target,
            baseline,
            restored,
            signal,
          });
          if (
            verification?.exact !== true ||
            verification?.restored !== true ||
            !DIGEST.test(verification.afterDigest ?? '')
          ) {
            throw new Error('baseline restore was not exact');
          }
          afterDigest = verification.afterDigest;
          if (afterDigest !== beforeDigest)
            throw new Error('baseline exact restore digest mismatch');
          return verification;
        },
        { recovery: true },
      );
    if (workspaceState && !unsettledOperation) {
      try {
        const removed = await boundedCall(
          'workspace.remove',
          ({ signal }) => workspace.remove(workspaceState.root, { signal }),
          { recovery: true },
        );
        cleanupVerified = removed?.removed === true && removed?.verified === true;
        if (!cleanupVerified) {
          failure = true;
        }
      } catch {
        cleanupVerified = false;
        failure = true;
      }
    }
    try {
      markTotal();
    } catch {
      failure = true;
      durations.total = Math.max(0, durations.total);
    }
  }

  const baselineRestored = afterDigest === beforeDigest;
  let privateEnvelopeDigest = digest('private-attestation-unavailable');
  const candidatePass =
    !failure &&
    !timedOut &&
    readiness.install === 'ready' &&
    readiness.setup === 'ready' &&
    readiness.client === 'ready' &&
    readiness.first_request === 'ready' &&
    evidence.apply === 'completed' &&
    evidence.guild_blueprint_evidence === 'verified' &&
    callerOwnedBot &&
    bindingVerified &&
    cleanProfile &&
    cleanupVerified &&
    isolatedSession &&
    dangerousPermissions === false &&
    buildDigests !== null &&
    DIGEST.test(configDigest) &&
    DIGEST.test(sessionDigest) &&
    activityEvidence !== null &&
    executionProvenance.execution_mode === request.executionMode &&
    executionProvenance.abortable === true &&
    sessionClosed &&
    baselineRestored &&
    durations.total < request.maxDurationMs;
  let passed = candidatePass;
  if (candidatePass) {
    try {
      if (typeof dependencies.persistAttestation !== 'function')
        throw new Error('attestation persistence adapter is required');
      const envelope = {
        schema_version: 'discord-mcp.activation-attestation.v1',
        context: 'discord-mcp.activation-attestation:hmac:v1',
        run_id: request.runId,
        trial_id: request.trialId,
        host: 'codex',
        host_version: request.hostVersion,
        release: request.release,
        source_commit: request.sourceCommit,
        binding: { guild_id: request.target.guildId, bot_id: request.target.botId },
        execution_provenance: executionProvenance,
        profile: {
          kind: 'clean_temp',
          config_digest: configDigest,
          cleanup_verified: cleanupVerified,
          token_persisted: false,
        },
        build: buildDigests,
        guild_blueprint_evidence: activityEvidence,
        evidence_digest: canonicalActivationEvidenceDigest(activityEvidence),
        baseline: {
          before_digest: beforeDigest,
          after_digest: afterDigest,
          restored: true,
          exact: true,
        },
        public_trial_digest: `sha256:${'0'.repeat(64)}`,
      };
      const unsignedPayload = {
        schema_version: 'discord-mcp.activation-trial.v2',
        host: 'codex',
        host_version: request.hostVersion,
        release: request.release,
        source_commit: request.sourceCommit,
        trial_id: request.trialId,
        execution_mode: request.executionMode,
        result: 'passed',
        phase_durations_ms: durations,
        readiness,
        terminal_status: 'passed',
        evidence,
        digests: { build: buildDigest, evidence: evidenceDigest, session: sessionDigest },
        safety: {
          secret_free: true,
          caller_owned_bot: callerOwnedBot,
          binding_verified: bindingVerified,
          clean_profile: cleanProfile,
          isolated_session: isolatedSession,
          dangerous_permissions: dangerousPermissions,
        },
        baseline: {
          restored: baselineRestored,
          exact: baselineRestored,
          before_digest: beforeDigest,
          after_digest: afterDigest,
        },
      };
      const publicTrialDigest = activationTrialDigest(unsignedPayload);
      envelope.public_trial_digest = publicTrialDigest;
      const privateAttestation = createActivationAttestation({
        envelope,
        integrityKey: request.token,
      });
      const verifiedAttestation = verifyActivationAttestation({
        attestation: privateAttestation,
        integrityKey: request.token,
        validateActivityEvidence: (value) =>
          activityEvidenceValidated &&
          canonicalActivationEvidenceDigest(value) ===
            canonicalActivationEvidenceDigest(activityEvidence),
      });
      privateEnvelopeDigest = canonicalActivationAttestationDigest(verifiedAttestation);
      const persisted = await boundedCall('persistAttestation', ({ signal }) =>
        dependencies.persistAttestation({
          runId: request.runId,
          trialId: request.trialId,
          attestation: verifiedAttestation,
          digest: privateEnvelopeDigest,
          signal,
        }),
      );
      if (persisted?.persisted !== true || persisted.digest !== privateEnvelopeDigest)
        throw new Error('private attestation persistence was not confirmed');
    } catch {
      passed = false;
    }
  }
  const payload = {
    schema_version: 'discord-mcp.activation-trial.v2',
    host: 'codex',
    host_version: request.hostVersion,
    release: request.release,
    source_commit: request.sourceCommit,
    trial_id: request.trialId,
    execution_mode: request.executionMode,
    result: passed ? 'passed' : 'failed',
    phase_durations_ms: durations,
    readiness,
    terminal_status: passed ? 'passed' : timedOut ? 'timeout' : 'failed',
    evidence,
    digests: { build: buildDigest, evidence: evidenceDigest, session: sessionDigest },
    safety: {
      secret_free: true,
      caller_owned_bot: callerOwnedBot,
      binding_verified: bindingVerified,
      clean_profile: cleanProfile,
      isolated_session: isolatedSession,
      dangerous_permissions: dangerousPermissions,
    },
    baseline: {
      restored: baselineRestored,
      exact: baselineRestored,
      before_digest: beforeDigest,
      after_digest: afterDigest,
    },
  };
  const artifact = createActivationTrialArtifact({
    ...payload,
    attestation: {
      schema_version: 'discord-mcp.activation-attestation-ref.v1',
      envelope_digest: privateEnvelopeDigest,
      trial_digest: activationTrialDigest(payload),
    },
  });
  return { ok: passed, artifact };
}
