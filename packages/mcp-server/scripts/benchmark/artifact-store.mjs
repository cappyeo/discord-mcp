import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { assertSecretFreeJson } from './manifest.mjs';

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RELATIVE_ARTIFACT = /^[a-zA-Z0-9._/-]+$/;
const MAX_BASELINE_BYTES = 20 * 1024 * 1024;
const BASELINE_INTEGRITY_ALGORITHM = 'hmac-sha256';
const BASELINE_INTEGRITY_CONTEXT = 'discord-mcp-benchmark-baseline:v1';
const LEGACY_BASELINE_SUFFIX = '.legacy.json';

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

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function integrityKey(value) {
  const key = value;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('benchmark artifact integrity key is required');
  }
  return Buffer.from(key.trim(), 'utf8');
}

function baselineIntegrityPayload(baseline, guildId) {
  if (baseline?.artifact_integrity !== undefined) {
    throw new Error('baseline artifact integrity metadata is reserved');
  }
  return `${BASELINE_INTEGRITY_CONTEXT}\0${guildId}\0${canonicalJson(baseline)}`;
}

function baselineIntegrityDigest(baseline, guildId, key) {
  return createHmac('sha256', integrityKey(key))
    .update(baselineIntegrityPayload(baseline, guildId), 'utf8')
    .digest('hex');
}

export function signBaselineArtifact(
  baseline,
  { guildId = baseline?.guild_id, integrityKey: key } = {},
) {
  if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
    throw new TypeError('baseline guildId is invalid');
  }
  assertSecretFreeJson(baseline);
  const digest = baselineIntegrityDigest(baseline, guildId, key);
  return {
    ...baseline,
    artifact_integrity: {
      algorithm: BASELINE_INTEGRITY_ALGORITHM,
      digest,
    },
  };
}

export function assertBaselineArtifactIntegrity(
  baseline,
  { guildId = baseline?.guild_id, integrityKey: key } = {},
) {
  if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
    throw new TypeError('baseline guildId is invalid');
  }
  const metadata = baseline?.artifact_integrity;
  if (
    metadata?.algorithm !== BASELINE_INTEGRITY_ALGORITHM ||
    typeof metadata.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.digest)
  ) {
    throw new Error('baseline artifact integrity metadata is malformed');
  }
  const expected = baselineIntegrityDigest(
    Object.fromEntries(Object.entries(baseline).filter(([name]) => name !== 'artifact_integrity')),
    guildId,
    key,
  );
  const actualBytes = Buffer.from(metadata.digest, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('baseline artifact integrity check failed');
  }
  return baseline;
}

async function readBaselineJson(path, guildId) {
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

async function baselinePaths({ cwd, artifactRoot, guildId }) {
  if (typeof guildId !== 'string' || !/^\d{17,20}$/.test(guildId)) {
    throw new TypeError('guildId is invalid');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const directory = join(root, 'baselines');
  await assertNoSymlinkPath(directory, 'baseline artifact directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(directory, 'baseline artifact directory');
  return {
    directory,
    path: join(directory, `${guildId}.json`),
    backupPath: join(directory, `${guildId}${LEGACY_BASELINE_SUFFIX}`),
  };
}

/** Read only an unsigned, bounded legacy artifact for explicit migration. */
export async function readLegacyBaselineArtifact({ cwd, artifactRoot, guildId }) {
  const { path } = await baselinePaths({ cwd, artifactRoot, guildId });
  await assertNoSymlinkPath(path, 'baseline artifact target');
  const baseline = await readBaselineJson(path, guildId);
  if (baseline?.artifact_integrity !== undefined) {
    throw new Error('baseline artifact is already signed');
  }
  return baseline;
}

/** Atomically retain the exact legacy inode and publish its signed replacement. */
export async function installSignedBaselineArtifact({
  cwd,
  artifactRoot,
  baseline,
  integrityKey: key,
}) {
  if (typeof baseline?.guild_id !== 'string' || !/^\d{17,20}$/.test(baseline.guild_id)) {
    throw new TypeError('baseline guild_id is invalid');
  }
  if (baseline.artifact_integrity !== undefined) {
    throw new Error('baseline artifact is already signed');
  }
  const { directory, path, backupPath } = await baselinePaths({
    cwd,
    artifactRoot,
    guildId: baseline.guild_id,
  });
  await assertNoSymlinkPath(path, 'baseline artifact target');
  await assertNoSymlinkPath(backupPath, 'legacy baseline backup target');
  const current = await readBaselineJson(path, baseline.guild_id);
  if (current.artifact_integrity !== undefined) {
    throw new Error('baseline artifact is already signed');
  }
  if (canonicalJson(current) !== canonicalJson(baseline)) {
    throw new Error('legacy baseline changed during migration');
  }

  const signed = signBaselineArtifact(baseline, {
    guildId: baseline.guild_id,
    integrityKey: key,
  });
  const temporary = join(
    directory,
    `.${baseline.guild_id}.signed.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const payload = `${JSON.stringify(signed, null, 2)}\n`;
  let handle;
  let backupCreated = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    let backup;
    try {
      backup = await readBaselineJson(backupPath, baseline.guild_id);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (backup !== undefined) {
      if (backup.artifact_integrity !== undefined) {
        throw new Error('legacy baseline backup is signed');
      }
      if (canonicalJson(backup) !== canonicalJson(baseline)) {
        throw new Error('legacy baseline backup does not match the verified record');
      }
    } else {
      await link(path, backupPath);
      backupCreated = true;
    }
    const verifiedBackup = await readBaselineJson(backupPath, baseline.guild_id);
    if (
      verifiedBackup.artifact_integrity !== undefined ||
      canonicalJson(verifiedBackup) !== canonicalJson(baseline)
    ) {
      throw new Error('legacy baseline backup does not match the verified record');
    }
    await rename(temporary, path);
  } catch (error) {
    if (backupCreated) await unlink(backupPath).catch(() => undefined);
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { path, backupPath, baseline: signed };
}

/** Verify a legacy record against live Discord before installing any file. */
export async function recoverLegacyBaselineArtifact({
  cwd,
  artifactRoot,
  guildId,
  integrityKey: key,
  verify,
}) {
  if (typeof verify !== 'function') throw new TypeError('baseline verification is required');
  const legacy = await readLegacyBaselineArtifact({ cwd, artifactRoot, guildId });
  const signed = signBaselineArtifact(legacy, { guildId, integrityKey: key });
  await verify(signed);
  return installSignedBaselineArtifact({
    cwd,
    artifactRoot,
    baseline: legacy,
    integrityKey: key,
  });
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

export async function writeBaselineArtifact({ cwd, artifactRoot, baseline, integrityKey: key }) {
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
  await writeJsonExclusive(
    path,
    signBaselineArtifact(baseline, { guildId: baseline.guild_id, integrityKey: key }),
  );
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

export async function readBaselineArtifact({ cwd, artifactRoot, guildId, integrityKey: key }) {
  const { path } = await baselinePaths({ cwd, artifactRoot, guildId });
  await assertNoSymlinkPath(path, 'baseline artifact target');
  const baseline = await readBaselineJson(path, guildId);
  assertBaselineArtifactIntegrity(baseline, { guildId, integrityKey: key });
  return baseline;
}
