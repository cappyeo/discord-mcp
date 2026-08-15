import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
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

import { sameFileIdentity } from './file-identity.mjs';
import {
  createNpmAuditEnvironment,
  NPM_REGISTRY_URL,
  resolveTrustedNpmCli,
  verifyInstalledNpmProvenance,
} from './npm-provenance.mjs';

const execFile = promisify(nodeExecFile);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TRIAL = /^[a-z][a-z0-9._-]{2,63}$/;
const ACTIVATION_PHASE_TIMEOUT_MS = 180_000;
const ACTIVATION_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_TREE_BYTES = 128 * 1024 * 1024;
const CONFIG_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
}

function digest(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function defaultRunCommand(command, args, options) {
  return execFile(command, args, options);
}

function defaultProfileEnvironmentKey(platform = process.platform) {
  return platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
}

function assertConfigFileName(value) {
  if (typeof value !== 'string' || !CONFIG_FILE_NAME.test(value))
    throw new TypeError('configFileName must be a safe basename');
  return value;
}

export function createActivationWorkspace({
  host = 'activation',
  platform = process.platform,
  configFileName = 'config.toml',
} = {}) {
  assertString(host, 'host', /^[a-z][a-z0-9._-]{1,31}$/);
  assertConfigFileName(configFileName);
  const profileEnvironmentKey = defaultProfileEnvironmentKey(platform);
  return {
    async create({ trialId, signal }) {
      assertString(trialId, 'trialId', TRIAL);
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new TypeError('signal must be an AbortSignal');
      signal?.throwIfAborted();
      let root;
      try {
        root = await mkdtemp(join(tmpdir(), `discord-mcp-${host}-${trialId}-`));
        if (platform !== 'win32') await chmod(root, 0o700);
        signal?.throwIfAborted();
        const home = join(root, `${host}-home`);
        const installRoot = join(root, 'public-install');
        const profileRoot = join(root, platform === 'win32' ? 'appdata' : 'xdg-config');
        const stateDirectory = join(root, 'blueprint-state');
        await Promise.all(
          [home, installRoot, profileRoot, stateDirectory].map((path) =>
            mkdir(path, { recursive: false, mode: 0o700 }),
          ),
        );
        signal?.throwIfAborted();
        return {
          root,
          home,
          installRoot,
          profileRoot,
          profileEnvironmentKey,
          configPath: join(home, configFileName),
          stateDirectory,
          cleanProfile: true,
        };
      } catch (error) {
        if (root !== undefined) await rm(root, { recursive: true, force: true });
        throw error;
      }
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

async function readPackageFile(path, platform = process.platform) {
  const initial = await lstat(path);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_PACKAGE_FILE_BYTES)
    throw new Error('installed package contains an invalid file');
  const flags = fsConstants.O_RDONLY | (platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
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

export async function hashActivationPackageTree(root, { platform = process.platform } = {}) {
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
        const bytes = await readPackageFile(entryPath, platform);
        totalBytes += bytes.length;
        if (totalBytes > MAX_PACKAGE_TREE_BYTES)
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

function setupEnvironment({
  childEnvironment,
  home,
  profileRoot,
  profileEnvironmentKey,
  token,
  buildEnvironment,
}) {
  if (typeof buildEnvironment === 'function')
    return buildEnvironment({ childEnvironment, home, profileRoot, profileEnvironmentKey, token });
  return {
    ...childEnvironment,
    [profileEnvironmentKey]: profileRoot,
    DISCORD_TOKEN: token,
  };
}

/** Build the host-neutral verified public-package dependency substrate. */
export function createActivationDependencies({
  host = 'activation',
  platform = process.platform,
  runCommand = defaultRunCommand,
  verifyProvenance = verifyInstalledNpmProvenance,
  environment = process.env,
  resolveNpmCli = resolveTrustedNpmCli,
  setupArgs,
  parseSetup,
  assertConfigReady,
  assertConfigWritable,
  enableWrites,
  buildEnvironment,
  createLiveAdapter,
  executionProvenance,
  authPreflight,
  configFileName = 'config.toml',
} = {}) {
  if (!record(environment)) throw new TypeError('environment is required');
  for (const [name, value] of Object.entries({
    setupArgs,
    parseSetup,
    assertConfigReady,
    assertConfigWritable,
    enableWrites,
    createLiveAdapter,
  }))
    if (typeof value !== 'function') throw new TypeError(`${name} callback is required`);
  if (!record(executionProvenance)) throw new TypeError('executionProvenance is required');
  if (authPreflight !== undefined && typeof authPreflight !== 'function')
    throw new TypeError('authPreflight must be a function');
  const workspace = createActivationWorkspace({ host, platform, configFileName });
  const profileEnvironmentKey = defaultProfileEnvironmentKey(platform);
  const childEnvironment = createNpmAuditEnvironment({
    env: environment,
    nodeExecPath: process.execPath,
    platform,
  });
  const verifyRuntimePackage = async ({ installRoot, install }) => {
    if (
      !record(install) ||
      !DIGEST.test(install.cliDigest ?? '') ||
      !DIGEST.test(install.coreDigest ?? '')
    )
      throw new Error('installed runtime provenance is unavailable');
    const cliRoot = join(installRoot, 'node_modules', '@discord-mcp', 'cli');
    const coreRoot = join(installRoot, 'node_modules', '@discord-mcp', 'core');
    const [cliDigest, coreDigest] = await Promise.all([
      hashActivationPackageTree(cliRoot, { platform }),
      hashActivationPackageTree(coreRoot, { platform }),
    ]);
    if (cliDigest !== install.cliDigest || coreDigest !== install.coreDigest)
      throw new Error('installed runtime changed after provenance verification');
    return {
      cliPath: join(cliRoot, 'dist', 'cli.js'),
      corePath: join(coreRoot, 'dist', 'index.js'),
    };
  };
  const liveAdapter = createLiveAdapter({ environment, verifyRuntimePackage });
  const dependencies = {
    workspace: Object.freeze(workspace),
    executionProvenance: Object.freeze(executionProvenance),
    ...(authPreflight === undefined ? {} : { authPreflight }),
    async install({ release, sourceCommit, installRoot, signal }) {
      const packageSpec = `@discord-mcp/cli@${release}`;
      const npmCliPath = await resolveNpmCli({ execPath: process.execPath, platform });
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
          timeout: ACTIVATION_PHASE_TIMEOUT_MS,
          maxBuffer: ACTIVATION_MAX_BUFFER,
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
      const cliDigest = await hashActivationPackageTree(cliRoot, { platform });
      const coreDigest = await hashActivationPackageTree(coreRoot, { platform });
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
        [entrypoint, ...setupArgs({ profile, guildId: target.guildId, configPath })],
        {
          cwd: installRoot,
          env: setupEnvironment({
            childEnvironment,
            home,
            profileRoot,
            profileEnvironmentKey,
            token,
            buildEnvironment,
          }),
          timeout: ACTIVATION_PHASE_TIMEOUT_MS,
          maxBuffer: ACTIVATION_MAX_BUFFER,
          windowsHide: true,
          signal,
        },
      );
      const config = await readFile(configPath, 'utf8').catch(() => '');
      let verified;
      try {
        verified = parseSetup(result.stdout ?? '', target);
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
    assertConfigReady,
    assertConfigWritable,
    enableWrites,
    ...liveAdapter,
  };
  Object.freeze(dependencies);
  return dependencies;
}
