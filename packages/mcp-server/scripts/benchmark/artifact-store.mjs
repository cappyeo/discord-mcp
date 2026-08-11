import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { assertSecretFreeJson } from './manifest.mjs';

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RELATIVE_ARTIFACT = /^[a-zA-Z0-9._/-]+$/;
const MAX_BASELINE_BYTES = 20 * 1024 * 1024;

function within(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function assertNoSymlinkPath(path, description) {
  let current = resolve(path);
  while (true) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${description} must not contain a symlink`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function safeRelativePath(path) {
  if (
    typeof path !== 'string' ||
    !RELATIVE_ARTIFACT.test(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new TypeError('artifact path must be a safe relative POSIX path');
  }
  return path;
}

async function writeJsonExclusive(path, value) {
  assertSecretFreeJson(value);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function ensureArtifactRoot({ cwd, artifactRoot }) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new TypeError('cwd is required');
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
    throw new TypeError('artifactRoot must be an absolute path');
  }
  const sourceRoot = await realpath(cwd);
  const requestedRoot = resolve(artifactRoot);
  if (within(sourceRoot, requestedRoot)) {
    throw new Error('benchmark artifacts must be stored outside the source repository');
  }
  await assertNoSymlinkPath(requestedRoot, 'benchmark artifact root');
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(requestedRoot, 'benchmark artifact root');
  const root = await realpath(requestedRoot);
  if (within(sourceRoot, root)) {
    throw new Error('benchmark artifact root resolves inside the source repository');
  }
  return root;
}

export async function prepareArtifactStore({ cwd, artifactRoot, runId }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const runDirectory = join(root, 'runs', runId);
  const runsDirectory = join(root, 'runs');
  await assertNoSymlinkPath(runsDirectory, 'benchmark runs directory');
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(runsDirectory, 'benchmark runs directory');
  await assertNoSymlinkPath(runDirectory, 'benchmark run directory');
  await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  await assertNoSymlinkPath(runDirectory, 'benchmark run directory');
  const resultsDirectory = join(runDirectory, 'results');
  const stateDirectory = join(runDirectory, 'state');
  await assertNoSymlinkPath(resultsDirectory, 'artifact results directory');
  await mkdir(resultsDirectory, { mode: 0o700 });
  await assertNoSymlinkPath(resultsDirectory, 'artifact results directory');
  await assertNoSymlinkPath(stateDirectory, 'artifact state directory');
  await mkdir(stateDirectory, { mode: 0o700 });
  await assertNoSymlinkPath(stateDirectory, 'artifact state directory');

  return {
    root,
    runDirectory,
    async writeArtifact(relativePath, value) {
      const target = resolve(runDirectory, safeRelativePath(relativePath));
      if (!within(runDirectory, target))
        throw new Error('artifact target escaped the run directory');
      await assertNoSymlinkPath(target, 'artifact target');
      await writeJsonExclusive(target, value);
    },
    async createStateDirectory(name) {
      if (typeof name !== 'string' || !RUN_ID.test(name)) {
        throw new TypeError('state directory name is invalid');
      }
      const target = join(runDirectory, 'state', name);
      await assertNoSymlinkPath(target, 'state directory target');
      await mkdir(target, { recursive: false, mode: 0o700 });
      await assertNoSymlinkPath(target, 'state directory target');
      return target;
    },
  };
}

export async function writeBaselineArtifact({ cwd, artifactRoot, baseline }) {
  if (typeof baseline?.guild_id !== 'string' || !/^\d{17,20}$/.test(baseline.guild_id)) {
    throw new TypeError('baseline guild_id is invalid');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const directory = join(root, 'baselines');
  await assertNoSymlinkPath(directory, 'baseline artifact directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(directory, 'baseline artifact directory');
  const path = join(directory, `${baseline.guild_id}.json`);
  await assertNoSymlinkPath(path, 'baseline artifact target');
  await writeJsonExclusive(path, baseline);
  return path;
}

export async function baselineArtifactExists({ cwd, artifactRoot, guildId }) {
  if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
    throw new TypeError('guildId is invalid');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const path = join(root, 'baselines', `${guildId}.json`);
  await assertNoSymlinkPath(path, 'baseline artifact target');
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readBaselineArtifact({ cwd, artifactRoot, guildId }) {
  if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
    throw new TypeError('guildId is invalid');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const path = join(root, 'baselines', `${guildId}.json`);
  await assertNoSymlinkPath(path, 'baseline artifact target');
  const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > MAX_BASELINE_BYTES) {
    throw new Error('baseline artifact is outside the size bound');
  }
  let baseline;
  try {
    baseline = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('baseline artifact is not valid JSON');
  }
  assertSecretFreeJson(baseline);
  if (baseline?.guild_id !== guildId) {
    throw new Error('baseline artifact guild_id does not match its requested guild');
  }
  return baseline;
}
