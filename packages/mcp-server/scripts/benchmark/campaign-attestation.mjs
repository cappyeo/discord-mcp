import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { assertSecretFreeJson, canonicalJson } from './manifest.mjs';

export const CAMPAIGN_ATTESTATION_SCHEMA = 'discord-mcp.real-benchmark-attestation.v1';
export const CAMPAIGN_ATTESTATION_CONTEXT = 'discord-mcp.real-benchmark-attestation:v1';
export const CAMPAIGN_ATTESTATION_ALGORITHM = 'hmac-sha256';

// Keep this list deliberately closed. The attestation must cover every
// evidence file that can make a real campaign appear successful, while
// excluding its own self-referential metadata and disposable state folders.
export const CAMPAIGN_ARTIFACT_PATHS = Object.freeze([
  'manifest.json',
  'quota-preflight.json',
  'safety-cases.json',
  'report.json',
  ...Array.from(
    { length: 20 },
    (_, index) => `results/trial-${String(index + 1).padStart(2, '0')}.json`,
  ),
]);

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ATTESTATION_BYTES = 1024 * 1024;
const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_REPORT_BYTES = 50 * 1024 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new TypeError('runId is invalid');
  return value;
}

function assertCommit(value) {
  if (typeof value !== 'string' || !COMMIT.test(value)) throw new TypeError('commit is invalid');
  return value;
}

function assertKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('integrityKey is required');
  }
  return Buffer.from(value.trim(), 'utf8');
}

function assertRunDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError('runDirectory must be an absolute path');
  }
  return resolve(value);
}

async function assertNoSymlinkPath(path, label) {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function maxBytesFor(path) {
  if (path === 'report.json') return MAX_REPORT_BYTES;
  if (path.startsWith('results/')) return MAX_RESULT_BYTES;
  return MAX_CONTROL_BYTES;
}

async function hashRegularFile(path, label, maxBytes) {
  await assertNoSymlinkPath(path, label);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error(`${label} is outside the size bound`);
  }

  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size < 2 ||
      opened.size > maxBytes
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maxBytes) throw new Error(`${label} is outside the size bound`);
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    const final = await handle.stat();
    if (
      final.dev !== metadata.dev ||
      final.ino !== metadata.ino ||
      final.size !== total ||
      total < 2 ||
      total > maxBytes
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return `sha256:${digest.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

async function hashArtifactMap(runDirectory) {
  const artifacts = {};
  for (const relativePath of CAMPAIGN_ARTIFACT_PATHS) {
    const path = join(runDirectory, relativePath);
    artifacts[relativePath] = await hashRegularFile(
      path,
      `campaign artifact ${relativePath}`,
      maxBytesFor(relativePath),
    );
  }
  return artifacts;
}

function assertExactArtifactMap(value) {
  if (!record(value)) throw new Error('campaign attestation artifact map is malformed');
  const keys = Object.keys(value).sort();
  const expected = [...CAMPAIGN_ARTIFACT_PATHS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('campaign attestation artifact map is not exact');
  }
  for (const key of expected) {
    if (typeof value[key] !== 'string' || !DIGEST.test(value[key])) {
      throw new Error(`campaign attestation digest is malformed for ${key}`);
    }
  }
  return value;
}

function payloadFor({ schema_version, run_id, commit, artifacts }) {
  return { schema_version, run_id, commit, artifacts };
}

function digestPayload(payload, key) {
  return createHmac('sha256', assertKey(key))
    .update(`${CAMPAIGN_ATTESTATION_CONTEXT}\0${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

function createAttestation({ runId, commit, artifacts, integrityKey }) {
  const payload = payloadFor({
    schema_version: CAMPAIGN_ATTESTATION_SCHEMA,
    run_id: assertRunId(runId),
    commit: assertCommit(commit),
    artifacts: assertExactArtifactMap(artifacts),
  });
  const attestation = {
    ...payload,
    integrity: {
      algorithm: CAMPAIGN_ATTESTATION_ALGORITHM,
      context: CAMPAIGN_ATTESTATION_CONTEXT,
      digest: digestPayload(payload, integrityKey),
    },
  };
  assertSecretFreeJson(attestation);
  return attestation;
}

function assertAttestationShape(value, { runId, commit } = {}) {
  if (!record(value)) throw new Error('campaign attestation is malformed');
  const expectedKeys = ['artifacts', 'commit', 'integrity', 'run_id', 'schema_version'];
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new Error('campaign attestation contains unexpected fields');
  }
  if (value.schema_version !== CAMPAIGN_ATTESTATION_SCHEMA) {
    throw new Error('campaign attestation schema is unsupported');
  }
  if (value.run_id !== assertRunId(runId) || value.commit !== assertCommit(commit)) {
    throw new Error('campaign attestation identity does not match the requested campaign');
  }
  assertExactArtifactMap(value.artifacts);
  const integrity = value.integrity;
  if (
    !record(integrity) ||
    Object.keys(integrity).sort().join('\0') !== ['algorithm', 'context', 'digest'].join('\0') ||
    integrity.algorithm !== CAMPAIGN_ATTESTATION_ALGORITHM ||
    integrity.context !== CAMPAIGN_ATTESTATION_CONTEXT ||
    typeof integrity.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(integrity.digest)
  ) {
    throw new Error('campaign attestation integrity metadata is malformed');
  }
  assertSecretFreeJson(value);
  return value;
}

async function readAttestation(path) {
  await assertNoSymlinkPath(path, 'campaign attestation');
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > MAX_ATTESTATION_BYTES
  ) {
    throw new Error('campaign attestation is outside the size bound');
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new Error('campaign attestation changed while opening');
    }
    const buffer = Buffer.alloc(MAX_ATTESTATION_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      total += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    const final = await handle.stat();
    if (
      final.dev !== metadata.dev ||
      final.ino !== metadata.ino ||
      final.size !== total ||
      total < 2 ||
      total > MAX_ATTESTATION_BYTES
    ) {
      throw new Error('campaign attestation changed while reading');
    }
    try {
      return JSON.parse(buffer.subarray(0, total).toString('utf8'));
    } catch {
      throw new Error('campaign attestation is not valid JSON');
    }
  } finally {
    await handle.close();
  }
}

/** Create the exclusive, secret-free HMAC envelope after all campaign files exist. */
export async function writeCampaignAttestation({ runDirectory, runId, commit, integrityKey } = {}) {
  const directory = assertRunDirectory(runDirectory);
  await assertNoSymlinkPath(directory, 'campaign run directory');
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error('campaign run directory is not a directory');
  }
  const artifacts = await hashArtifactMap(directory);
  const attestation = createAttestation({ runId, commit, artifacts, integrityKey });
  const path = join(directory, 'attestation.json');
  await assertNoSymlinkPath(path, 'campaign attestation');
  const payload = `${JSON.stringify(attestation, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_ATTESTATION_BYTES) {
    throw new Error('campaign attestation is outside the size bound');
  }
  await writeFile(path, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return attestation;
}

/** Verify the envelope, HMAC, and every fixed evidence-file digest. */
export async function verifyCampaignAttestation({
  runDirectory,
  runId,
  commit,
  integrityKey,
} = {}) {
  const directory = assertRunDirectory(runDirectory);
  await assertNoSymlinkPath(directory, 'campaign run directory');
  const value = await readAttestation(join(directory, 'attestation.json'));
  assertAttestationShape(value, { runId, commit });
  const payload = payloadFor(value);
  const expectedDigest = digestPayload(payload, integrityKey);
  const actualBytes = Buffer.from(value.integrity.digest, 'hex');
  const expectedBytes = Buffer.from(expectedDigest, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('campaign attestation HMAC check failed');
  }
  const actualArtifacts = await hashArtifactMap(directory);
  if (canonicalJson(actualArtifacts) !== canonicalJson(value.artifacts)) {
    throw new Error('campaign attestation artifact digest check failed');
  }
  return value;
}
