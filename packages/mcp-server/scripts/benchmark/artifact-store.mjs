import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sameFileIdentity } from './file-identity.mjs';
import { assertSecretFreeJson, strictRfc3339Milliseconds } from './manifest.mjs';

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RELATIVE_ARTIFACT = /^[a-zA-Z0-9._/-]+$/;
const MAX_BASELINE_BYTES = 20 * 1024 * 1024;
const MAX_ACTIVATION_ATTESTATION_BYTES = 1024 * 1024;
const BASELINE_INTEGRITY_ALGORITHM = 'hmac-sha256';
const BASELINE_INTEGRITY_CONTEXT = 'discord-mcp-benchmark-baseline:v1';
const LEGACY_BASELINE_SUFFIX = '.legacy.json';
const CAMPAIGN_LOCK_OWNER_KEYS = ['run_id', 'commit', 'started_at', 'pid', 'hostname'];
const MAX_CAMPAIGN_LOCK_OWNER_BYTES = 16 * 1024;
const SNOWFLAKE = /^\d{17,20}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const CAMPAIGN_LOCK_CONFIRMATION_PREFIX = 'RELEASE_DISCORD_MCP_LOCK:';

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

async function ensurePrivateDirectory(
  path,
  description,
  { platform = process.platform, enforceProfile = false, homeDirectory = homedir() } = {},
) {
  if (!isAbsolute(path)) throw new TypeError(`${description} must be absolute`);
  const requested = resolve(path);
  if (platform === 'win32' && enforceProfile) {
    const profileRoot = resolve(homeDirectory);
    if (!within(profileRoot, requested)) {
      throw new Error(`${description} must be inside the caller profile`);
    }
  }
  await assertNoSymlinkPath(requested, description);
  const missing = [];
  let existingAncestor = requested;
  while (true) {
    try {
      const metadata = await lstat(existingAncestor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${description} must not contain a non-directory path component`);
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(existingAncestor);
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error(`${description} has no existing directory ancestor`);
      }
      existingAncestor = parent;
    }
  }
  for (const component of missing.reverse()) {
    try {
      await mkdir(component, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const metadata = await lstat(component);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${description} changed while creating its path`);
      }
    }
    await assertNoSymlinkPath(component, description);
    if (platform !== 'win32') await chmod(component, PRIVATE_DIRECTORY_MODE);
  }
  await assertNoSymlinkPath(requested, description);
  if (platform !== 'win32') {
    await chmod(requested, PRIVATE_DIRECTORY_MODE);
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new Error(`${description} is not private`);
    }
  }
  const resolved = await realpath(requested);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${description} is not a directory`);
  }
  if (platform === 'win32' && enforceProfile) {
    const profileRoot = resolve(homeDirectory);
    if (!within(profileRoot, resolved)) {
      throw new Error(`${description} resolves outside the caller profile`);
    }
  }
  return resolved;
}

async function readBoundedRegularFile(path, maxBytes, description) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > maxBytes
  ) {
    throw new Error(`${description} is outside the size bound`);
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened) || opened.size !== metadata.size) {
      throw new Error(`${description} changed while opening`);
    }
    const buffer = Buffer.alloc(metadata.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      total += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    const final = await handle.stat();
    if (!sameFileIdentity(metadata, final) || final.size !== total || total !== metadata.size) {
      throw new Error(`${description} changed while reading`);
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
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
  const bytes = await readBoundedRegularFile(path, MAX_BASELINE_BYTES, 'baseline artifact');
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
  await ensurePrivateDirectory(directory, 'baseline artifact directory');
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

export async function ensureArtifactRoot({
  cwd,
  artifactRoot,
  platform = process.platform,
  homeDirectory = homedir(),
}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new TypeError('cwd is required');
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
    throw new TypeError('artifactRoot must be an absolute path');
  }
  const sourceRoot = await realpath(cwd);
  const requestedRoot = resolve(artifactRoot);
  if (within(sourceRoot, requestedRoot)) {
    throw new Error('benchmark artifacts must be stored outside the source repository');
  }
  const root = await ensurePrivateDirectory(requestedRoot, 'benchmark artifact root', {
    platform,
    enforceProfile: platform === 'win32',
    homeDirectory,
  });
  if (within(sourceRoot, root)) {
    throw new Error('benchmark artifact root resolves inside the source repository');
  }
  return root;
}

function validStrictRfc3339(value) {
  return strictRfc3339Milliseconds(value) !== null;
}

function assertCampaignLockOwner(owner, { normalize = true, requireFull = false } = {}) {
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new TypeError('campaign lock owner is required');
  }
  const keys = Object.keys(owner).sort();
  const identityKeys = ['commit', 'run_id', 'started_at'];
  const fullKeys = CAMPAIGN_LOCK_OWNER_KEYS.slice().sort();
  const allowedKeys = requireFull
    ? [fullKeys.join('\0')]
    : [identityKeys.slice().sort().join('\0'), fullKeys.join('\0')];
  if (!allowedKeys.includes(keys.join('\0'))) {
    throw new TypeError('campaign lock owner contains unexpected fields');
  }
  if (typeof owner.run_id !== 'string' || !RUN_ID.test(owner.run_id)) {
    throw new TypeError('campaign lock owner run_id is invalid');
  }
  if (typeof owner.commit !== 'string' || !/^[a-f0-9]{40}$/.test(owner.commit)) {
    throw new TypeError('campaign lock owner commit is invalid');
  }
  if (!validStrictRfc3339(owner.started_at)) {
    throw new TypeError('campaign lock owner started_at is invalid');
  }
  if (owner.pid !== undefined && (!Number.isSafeInteger(owner.pid) || owner.pid < 1)) {
    throw new TypeError('campaign lock owner pid is invalid');
  }
  if (
    owner.hostname !== undefined &&
    (typeof owner.hostname !== 'string' || owner.hostname.length < 1 || owner.hostname.length > 255)
  ) {
    throw new TypeError('campaign lock owner hostname is invalid');
  }
  assertSecretFreeJson(owner);
  if (!normalize || (owner.pid !== undefined && owner.hostname !== undefined)) return owner;
  return { ...owner, pid: process.pid, hostname: hostname() };
}

function campaignLockDirectory({ botId, guildIds }) {
  if (typeof botId !== 'string' || !SNOWFLAKE.test(botId)) {
    throw new TypeError('campaign lock botId is invalid');
  }
  if (
    !Array.isArray(guildIds) ||
    guildIds.length === 0 ||
    guildIds.some((guildId) => typeof guildId !== 'string' || !SNOWFLAKE.test(guildId))
  ) {
    throw new TypeError('campaign lock guildIds are invalid');
  }
  const normalizedGuildIds = [...guildIds].sort();
  if (new Set(normalizedGuildIds).size !== normalizedGuildIds.length) {
    throw new TypeError('campaign lock guildIds must be unique');
  }
  const identity = `discord-mcp.real-benchmark:v1|bot=${botId}|guilds=${normalizedGuildIds.join(',')}`;
  return `discord-mcp-campaign-lock-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function defaultCampaignLockRoot({ homeDirectory = homedir() } = {}) {
  if (typeof homeDirectory !== 'string' || !isAbsolute(homeDirectory)) {
    throw new TypeError('homeDirectory must be an absolute path');
  }
  return join(resolve(homeDirectory), '.discord-mcp', 'locks');
}

export function campaignLockConfirmation({ botId, guildIds }) {
  return `${CAMPAIGN_LOCK_CONFIRMATION_PREFIX}${campaignLockDirectory({ botId, guildIds })}`;
}

async function resolveCampaignLockRoot(
  lockRoot,
  { platform = process.platform, homeDirectory = homedir() } = {},
) {
  const requested = lockRoot ?? defaultCampaignLockRoot({ homeDirectory });
  if (typeof requested !== 'string' || !isAbsolute(requested)) {
    throw new TypeError('lockRoot must be an absolute path');
  }
  return ensurePrivateDirectory(requested, 'campaign lock root', {
    platform,
    enforceProfile: platform === 'win32',
    homeDirectory,
  });
}

function sameCampaignLockOwner(left, right) {
  return CAMPAIGN_LOCK_OWNER_KEYS.every((key) => left[key] === right[key]);
}

function assertOwnerProcessIsNotAlive(owner) {
  if (owner.hostname !== hostname()) {
    throw new Error('campaign lock owner process cannot be proven stopped');
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw new Error('campaign lock owner process cannot be proven stopped');
  }
  throw new Error('campaign lock owner process is still alive');
}

async function readCampaignLockOwner(lockPath) {
  const ownerPath = join(lockPath, 'owner.json');
  await assertNoSymlinkPath(lockPath, 'campaign lock');
  const lockMetadata = await lstat(lockPath);
  if (!lockMetadata.isDirectory()) throw new Error('campaign lock is not a directory');
  await assertNoSymlinkPath(ownerPath, 'campaign lock owner metadata');
  const ownerMetadata = await lstat(ownerPath);
  if (!ownerMetadata.isFile()) throw new Error('campaign lock owner metadata is not a file');
  if (ownerMetadata.size > MAX_CAMPAIGN_LOCK_OWNER_BYTES) {
    throw new Error('campaign lock owner metadata is outside the size bound');
  }
  let owner;
  try {
    owner = JSON.parse(
      (
        await readBoundedRegularFile(
          ownerPath,
          MAX_CAMPAIGN_LOCK_OWNER_BYTES,
          'campaign lock owner metadata',
        )
      ).toString('utf8'),
    );
  } catch {
    throw new Error('campaign lock owner metadata is unavailable');
  }
  try {
    return assertCampaignLockOwner(owner, { normalize: false, requireFull: true });
  } catch {
    throw new Error('campaign lock owner metadata is unavailable');
  }
}

async function publishCampaignLockOwner(ownerPath, lockPath, owner) {
  const temporary = join(lockPath, `.owner.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(owner, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Hard-link publication is atomic and never replaces an existing owner.
    await link(temporary, ownerPath);
    return true;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function removePublishedOwnerIfOwned(lockPath, owner) {
  try {
    const current = await readCampaignLockOwner(lockPath);
    if (sameCampaignLockOwner(current, owner)) {
      await unlink(join(lockPath, 'owner.json'));
    }
  } catch {
    // Preserve the lock if ownership cannot be proven.
  }
}

/** Acquire the fail-closed caller-scope campaign lock for the controlled guild pool. */
export async function acquireCampaignLock({
  botId,
  guildIds,
  owner,
  lockRoot,
  platform = process.platform,
  homeDirectory = homedir(),
}) {
  const requestedOwner = assertCampaignLockOwner(owner, { normalize: false });
  if (requestedOwner.pid !== undefined || requestedOwner.hostname !== undefined) {
    throw new TypeError('campaign lock acquisition owner must not provide pid or hostname');
  }
  const normalizedOwner = { ...requestedOwner, pid: process.pid, hostname: hostname() };
  const resolvedLockRoot = await resolveCampaignLockRoot(lockRoot, { platform, homeDirectory });
  const lockPath = join(resolvedLockRoot, campaignLockDirectory({ botId, guildIds }));
  await assertNoSymlinkPath(lockPath, 'campaign lock');
  try {
    await mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let heldBy;
    try {
      heldBy = await readCampaignLockOwner(lockPath);
    } catch {
      throw new Error('benchmark campaign lock is held but owner metadata is unavailable');
    }
    throw new Error(`benchmark campaign lock is held: ${JSON.stringify(heldBy)}`);
  }

  const ownerPath = join(lockPath, 'owner.json');
  let ownerPublished = false;
  try {
    await assertNoSymlinkPath(lockPath, 'campaign lock');
    ownerPublished = await publishCampaignLockOwner(ownerPath, lockPath, normalizedOwner);
    await assertNoSymlinkPath(ownerPath, 'campaign lock owner metadata');
  } catch (error) {
    if (ownerPublished) await removePublishedOwnerIfOwned(lockPath, normalizedOwner);
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    lockPath,
    async release() {
      if (released) return;
      const heldBy = await readCampaignLockOwner(lockPath);
      if (!sameCampaignLockOwner(heldBy, normalizedOwner)) {
        throw new Error('campaign lock owner metadata changed; refusing release');
      }
      await unlink(join(lockPath, 'owner.json'));
      await rmdir(lockPath);
      released = true;
    },
  };
}

/**
 * Explicitly release a lock after an interrupted campaign.
 *
 * This is intentionally never called by acquisition or campaign execution:
 * callers must provide the exact recorded owner and a confirmation bound to
 * the bot/guild lock identity. Missing or malformed owner metadata fails
 * closed and requires manual operator inspection.
 */
export async function recoverCampaignLock({
  botId,
  guildIds,
  owner,
  confirmation,
  lockRoot,
  platform = process.platform,
  homeDirectory = homedir(),
}) {
  assertCampaignLockOwner(owner, { normalize: false, requireFull: true });
  if (confirmation !== campaignLockConfirmation({ botId, guildIds })) {
    throw new Error('campaign lock recovery confirmation does not match the lock identity');
  }
  const resolvedLockRoot = await resolveCampaignLockRoot(lockRoot, { platform, homeDirectory });
  const lockPath = join(resolvedLockRoot, campaignLockDirectory({ botId, guildIds }));
  await assertNoSymlinkPath(lockPath, 'campaign lock');
  let heldBy;
  try {
    heldBy = await readCampaignLockOwner(lockPath);
  } catch {
    throw new Error('campaign lock recovery requires valid owner metadata');
  }
  if (!sameCampaignLockOwner(heldBy, owner)) {
    throw new Error('campaign lock recovery owner does not match');
  }
  assertOwnerProcessIsNotAlive(heldBy);
  const quarantinePath = join(
    resolvedLockRoot,
    `${basename(lockPath)}.quarantine.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  await assertNoSymlinkPath(quarantinePath, 'campaign lock quarantine');
  // Re-read and compare the complete owner immediately before the atomic move.
  const latestOwner = await readCampaignLockOwner(lockPath);
  if (!sameCampaignLockOwner(latestOwner, owner)) {
    throw new Error('campaign lock recovery owner changed before quarantine');
  }
  assertOwnerProcessIsNotAlive(latestOwner);
  try {
    // Keep the complete lock tree for inspection; never recursively delete it.
    await rename(lockPath, quarantinePath);
  } catch (error) {
    throw new Error(`campaign lock recovery could not quarantine the lock: ${error.message}`);
  }
  return { lockPath, quarantinePath, owner: latestOwner };
}

export async function prepareArtifactStore({ cwd, artifactRoot, runId }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const runDirectory = join(root, 'runs', runId);
  const runsDirectory = join(root, 'runs');
  await ensurePrivateDirectory(runsDirectory, 'benchmark runs directory');
  await assertNoSymlinkPath(runDirectory, 'benchmark run directory');
  await mkdir(runDirectory, { recursive: false, mode: 0o700 });
  await assertNoSymlinkPath(runDirectory, 'benchmark run directory');
  const resultsDirectory = join(runDirectory, 'results');
  const stateDirectory = join(runDirectory, 'state');
  await ensurePrivateDirectory(resultsDirectory, 'artifact results directory');
  await ensurePrivateDirectory(stateDirectory, 'artifact state directory');

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

/** Persist one private activation attestation under a digest-addressed filename. */
export async function writeActivationAttestationArtifact({
  cwd,
  artifactRoot,
  runId,
  trialId,
  digest,
  attestation,
}) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  if (typeof trialId !== 'string' || !RUN_ID.test(trialId))
    throw new TypeError('trialId is invalid');
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest ?? '');
  if (match === null) throw new TypeError('attestation digest is invalid');
  if (
    attestation === null ||
    typeof attestation !== 'object' ||
    Array.isArray(attestation) ||
    attestation.run_id !== runId ||
    attestation.trial_id !== trialId
  ) {
    throw new TypeError('attestation identity does not match its destination');
  }
  assertSecretFreeJson(attestation, 'activation_attestation');
  if (Buffer.byteLength(JSON.stringify(attestation), 'utf8') > MAX_ACTIVATION_ATTESTATION_BYTES) {
    throw new Error('activation attestation exceeds the size bound');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const evidenceDirectory = await ensurePrivateDirectory(
    join(root, 'activation-evidence', runId),
    'activation evidence directory',
  );
  const path = join(evidenceDirectory, `${match[1]}.json`);
  await assertNoSymlinkPath(path, 'activation attestation target');
  await writeJsonExclusive(path, attestation);
  return { persisted: true, digest, evidenceDirectory };
}

export async function writeBaselineArtifact({ cwd, artifactRoot, baseline, integrityKey: key }) {
  if (typeof baseline?.guild_id !== 'string' || !/^\d{17,20}$/.test(baseline.guild_id)) {
    throw new TypeError('baseline guild_id is invalid');
  }
  const root = await ensureArtifactRoot({ cwd, artifactRoot });
  const directory = join(root, 'baselines');
  await ensurePrivateDirectory(directory, 'baseline artifact directory');
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
