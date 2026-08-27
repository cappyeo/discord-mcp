#!/usr/bin/env node

import { promises as fs, constants as fsConstants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVATION_ARTIFACT_SCHEMA,
  assertActivationTrialArtifact,
} from './activation-artifact.mjs';
import {
  canonicalActivationAttestationDigest,
  verifyActivationAttestation,
} from './activation-attestation.mjs';
import { sameFileIdentity } from './file-identity.mjs';
import { assertSecretFreeJson } from './manifest.mjs';

export const ACTIVATION_VERIFIER_SCHEMA = 'discord-mcp.activation-trials-verifier.v2';
export const ACTIVATION_MAX_DURATION_MS = 600_000;
export const ACTIVATION_BUNDLE_SCHEMA = 'discord-mcp.activation-trials-bundle.v2';
export const ACTIVATION_MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const ACTIVATION_MAX_ENVELOPE_BYTES = 1024 * 1024;
export const ACTIVATION_MAX_TRIALS = 256;
export const PRODUCTION_ACTIVATION_HOSTS = Object.freeze([
  'codex',
  'claude-code',
  'antigravity-cli',
  'cursor-cli',
  'grok-cli',
]);

const DIGEST_RE = /^sha256:([a-f0-9]{64})$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const RELEASE_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const HOST_RE = /^[a-z][a-z0-9._-]{1,31}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new TypeError(`${label} must be an absolute path`);
  return value;
}

function assertPlainKeys(value, allowed, label) {
  if (!record(value)) throw new TypeError(`${label} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key}: unknown field`);
  }
}

function assertBinding(binding) {
  if (!record(binding) || !SNOWFLAKE_RE.test(binding.guildId) || !SNOWFLAKE_RE.test(binding.botId))
    throw new TypeError('expectedBinding must contain valid guildId and botId');
}

function envelopeFilename(digest) {
  const match = DIGEST_RE.exec(digest);
  if (!match) throw new TypeError('attestation.envelope_digest: invalid digest');
  return `${match[1]}.json`;
}

async function assertNoSymlinkRegular(path, label, { directory = false } = {}) {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error(`${label} must be a non-symlink ${directory ? 'directory' : 'regular file'}`);
  return stat;
}

async function assertSameRegularPath(path, initial, label) {
  const current = await assertNoSymlinkRegular(path, label);
  if (current.size !== initial.size || current.dev !== initial.dev || current.ino !== initial.ino)
    throw new Error(`${label} changed during read`);
}

async function readBoundedJson(path, label, maxBytes) {
  assertAbsolutePath(path, label);
  const initial = await assertNoSymlinkRegular(path, label);
  if (initial.size > maxBytes) throw new Error(`${label} exceeds size bound`);
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== initial.size ||
      before.size > maxBytes ||
      !sameFileIdentity(initial, before)
    )
      throw new Error(`${label} changed during read`);
    await assertSameRegularPath(path, initial, label);
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} changed during read`);
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new Error(`${label} changed during read`);
    await assertSameRegularPath(path, initial, label);
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    return parsed;
  } finally {
    await handle?.close();
  }
}

function assertBundle(value) {
  assertPlainKeys(value, new Set(['schema_version', 'trials']), 'bundle');
  if (value.schema_version !== ACTIVATION_BUNDLE_SCHEMA)
    throw new TypeError('bundle.schema_version: unsupported schema');
  if (
    !Array.isArray(value.trials) ||
    value.trials.length === 0 ||
    value.trials.length > ACTIVATION_MAX_TRIALS
  )
    throw new TypeError('bundle.trials: invalid trial count');
  return value;
}

function assertPublicPrivateMatch(publicTrial, privateAttestation, expectedBinding) {
  const fields = ['host', 'host_version', 'release', 'source_commit', 'trial_id'];
  for (const field of fields) {
    if (privateAttestation[field] !== publicTrial[field])
      throw new Error(`private attestation ${field} does not match public trial`);
  }
  if (privateAttestation.execution_provenance.execution_mode !== publicTrial.execution_mode)
    throw new Error('private execution provenance does not match public execution mode');
  if (
    privateAttestation.execution_provenance.execution_mode !== 'live' ||
    privateAttestation.execution_provenance.abortable !== true ||
    privateAttestation.execution_provenance.package_source !== 'verified_npm_provenance'
  )
    throw new Error('private execution provenance is not authoritative');
  if (privateAttestation.build.package_digest !== publicTrial.digests.build)
    throw new Error('private package digest does not match public build digest');
  if (privateAttestation.launcher_digest !== publicTrial.digests.launcher)
    throw new Error('private launcher digest does not match public launcher digest');
  if (privateAttestation.public_trial_digest !== publicTrial.attestation.trial_digest)
    throw new Error('private public_trial_digest does not match public trial digest');
  if (privateAttestation.guild_blueprint_evidence.evidence_id !== publicTrial.digests.evidence)
    throw new Error('private evidence id does not match public evidence digest');
  if (
    privateAttestation.baseline.before_digest !== publicTrial.baseline.before_digest ||
    privateAttestation.baseline.after_digest !== publicTrial.baseline.after_digest ||
    privateAttestation.baseline.restored !== publicTrial.baseline.restored ||
    privateAttestation.baseline.exact !== publicTrial.baseline.exact
  )
    throw new Error('private baseline does not match public baseline');
  if (
    privateAttestation.profile.cleanup_verified !== publicTrial.safety.clean_profile ||
    privateAttestation.profile.kind !== 'clean_temp' ||
    privateAttestation.profile.token_persisted !== false
  )
    throw new Error('private profile cleanup does not match public safety');
  if (
    privateAttestation.binding.guild_id !== expectedBinding.guildId ||
    privateAttestation.binding.bot_id !== expectedBinding.botId
  )
    throw new Error('private attestation target does not match expected binding');
}

function nearestRank(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1];
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function assertExpectedHosts(expectedHosts) {
  if (expectedHosts === undefined) return null;
  if (!Array.isArray(expectedHosts) || expectedHosts.length === 0)
    throw new TypeError('expectedHosts must be a non-empty array');
  const unique = new Set(expectedHosts);
  if (
    unique.size !== expectedHosts.length ||
    expectedHosts.some((host) => typeof host !== 'string')
  )
    throw new TypeError('expectedHosts must contain unique host names');
  return unique;
}

function assertExpectedRunId(expectedRunId) {
  if (typeof expectedRunId !== 'string' || !ID_RE.test(expectedRunId))
    throw new TypeError('expectedRunId must be a valid run id');
  return expectedRunId;
}

/**
 * Structurally verify public activation artifacts. Every observed host must
 * have exactly three unique trials, and every host's p90 must remain below
 * ten minutes. This public-only aggregate is not authoritative; callers must
 * use verifyActivationTrialsBundle() for private evidence and provenance.
 */
export function verifyActivationTrialAggregate({
  trials,
  expectedHosts,
  expectedRelease,
  expectedCommit,
  expectedBuildDigest,
  maxDurationMs = ACTIVATION_MAX_DURATION_MS,
} = {}) {
  if (!Array.isArray(trials) || trials.length === 0)
    throw new TypeError('trials must be a non-empty array');
  if (
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs <= 0 ||
    maxDurationMs > ACTIVATION_MAX_DURATION_MS
  )
    throw new TypeError('maxDurationMs must be between 1 and 600000');
  const requiredHosts = assertExpectedHosts(expectedHosts);
  const groups = new Map();
  const trialIds = new Set();
  for (const trial of trials) {
    assertActivationTrialArtifact(trial);
    if (trial.execution_mode !== 'live')
      throw new Error('activation campaign contains non-live execution evidence');
    if (trialIds.has(trial.trial_id))
      throw new Error('activation campaign contains duplicate trial ids');
    trialIds.add(trial.trial_id);
    if (!groups.has(trial.host)) groups.set(trial.host, []);
    groups.get(trial.host).push(trial);
  }
  if (
    requiredHosts &&
    (groups.size !== requiredHosts.size ||
      [...groups.keys()].some((host) => !requiredHosts.has(host)))
  )
    throw new Error('activation trial hosts do not match expected hosts');

  const releases = new Set(trials.map((trial) => trial.release));
  const commits = new Set(trials.map((trial) => trial.source_commit));
  const builds = new Set(trials.map((trial) => trial.digests.build));
  if (releases.size !== 1) throw new Error('activation campaign mixes release versions');
  if (commits.size !== 1) throw new Error('activation campaign mixes source commits');
  if (builds.size !== 1) throw new Error('activation campaign mixes public package builds');
  const release = trials[0].release;
  const sourceCommit = trials[0].source_commit;
  const buildDigest = trials[0].digests.build;
  if (expectedRelease !== undefined && expectedRelease !== release)
    throw new Error('activation campaign release does not match expected release');
  if (expectedCommit !== undefined && expectedCommit !== sourceCommit)
    throw new Error('activation campaign commit does not match expected commit');
  if (expectedBuildDigest !== undefined && expectedBuildDigest !== buildDigest)
    throw new Error('activation campaign build does not match expected build');
  const sessionDigests = new Set(trials.map((trial) => trial.digests.session));
  if (sessionDigests.size !== trials.length)
    throw new Error('activation campaign reuses a client session');
  const envelopeDigests = new Set(trials.map((trial) => trial.attestation.envelope_digest));
  if (envelopeDigests.size !== trials.length)
    throw new Error('activation campaign reuses a private attestation envelope');
  const evidenceIdentities = new Set(trials.map((trial) => trial.digests.evidence));
  if (evidenceIdentities.size !== trials.length)
    throw new Error('activation campaign reuses Activity Evidence identity');

  const summaries = [];
  for (const [host, hostTrials] of groups) {
    if (hostTrials.length !== 3) throw new Error(`host ${host} must have exactly three trials`);
    const ids = new Set(hostTrials.map((trial) => trial.trial_id));
    if (ids.size !== hostTrials.length)
      throw new Error(`host ${host} contains duplicate trial ids`);
    const hostVersions = new Set(hostTrials.map((trial) => trial.host_version));
    if (hostVersions.size !== 1) throw new Error(`host ${host} mixes client versions`);
    const launcherDigests = new Set(hostTrials.map((trial) => trial.digests.launcher));
    if (launcherDigests.size !== 1) throw new Error(`host ${host} mixes launcher identities`);
    for (const trial of hostTrials) {
      if (
        trial.result !== 'passed' ||
        trial.terminal_status !== 'passed' ||
        trial.readiness.install !== 'ready' ||
        trial.readiness.setup !== 'ready' ||
        trial.readiness.client !== 'ready' ||
        trial.readiness.first_request !== 'ready' ||
        trial.evidence.apply !== 'completed' ||
        trial.evidence.guild_blueprint_evidence !== 'verified' ||
        trial.safety.secret_free !== true ||
        trial.safety.caller_owned_bot !== true ||
        trial.safety.binding_verified !== true ||
        trial.safety.clean_profile !== true ||
        trial.safety.isolated_session !== true ||
        trial.safety.dangerous_permissions !== false ||
        trial.baseline.restored !== true ||
        trial.baseline.exact !== true ||
        trial.baseline.before_digest !== trial.baseline.after_digest
      )
        throw new Error(`host ${host} contains a trial without verified activation evidence`);
    }
    const durations = hostTrials.map((trial) => trial.phase_durations_ms.total);
    const p90 = nearestRank(durations, 0.9);
    const trialMedian = median(durations);
    if (!(trialMedian < maxDurationMs) || !(p90 < maxDurationMs))
      throw new Error(`host ${host} exceeds activation duration threshold`);
    summaries.push({
      host,
      host_version: hostTrials[0].host_version,
      release,
      source_commit: sourceCommit,
      build_digest: buildDigest,
      launcher_digest: hostTrials[0].digests.launcher,
      trial_count: hostTrials.length,
      trial_ids: [...ids],
      durations_ms: { median: trialMedian, p90 },
    });
  }
  summaries.sort((left, right) => left.host.localeCompare(right.host));
  return {
    schema_version: ACTIVATION_VERIFIER_SCHEMA,
    artifact_schema: ACTIVATION_ARTIFACT_SCHEMA,
    verified: true,
    release,
    source_commit: sourceCommit,
    build_digest: buildDigest,
    host_count: summaries.length,
    hosts: summaries,
  };
}

/**
 * Verify a public trial bundle against private, caller-owned attestation
 * envelopes. The private envelopes never enter the returned summary. The
 * campaign orchestrator must supply a freshly generated expectedRunId; repeat
 * verification of that same run remains intentionally idempotent.
 */
async function verifyActivationTrialsBundleDetailed({
  inputPath,
  evidenceDir,
  integrityKey,
  expectedBinding,
  expectedRunId,
  expectedHosts,
  expectedRelease,
  expectedCommit,
  expectedBuildDigest,
  maxDurationMs = ACTIVATION_MAX_DURATION_MS,
  validateActivityEvidence,
} = {}) {
  assertAbsolutePath(inputPath, 'inputPath');
  assertAbsolutePath(evidenceDir, 'evidenceDir');
  if (typeof integrityKey !== 'string' || integrityKey.trim() === '')
    throw new TypeError('integrityKey is required');
  assertBinding(expectedBinding);
  const requiredRunId = assertExpectedRunId(expectedRunId);
  if (typeof validateActivityEvidence !== 'function')
    throw new TypeError('validateActivityEvidence is required');
  await assertNoSymlinkRegular(evidenceDir, 'evidenceDir', { directory: true });
  const bundle = assertBundle(
    await readBoundedJson(inputPath, 'activation bundle', ACTIVATION_MAX_BUNDLE_BYTES),
  );
  const publicTrials = bundle.trials.map((value) => assertActivationTrialArtifact(value));
  const runIds = new Set();
  const evidenceDigests = new Set();
  for (const publicTrial of publicTrials) {
    const file = join(evidenceDir, envelopeFilename(publicTrial.attestation.envelope_digest));
    const privateAttestation = await readBoundedJson(
      file,
      'activation attestation envelope',
      ACTIVATION_MAX_ENVELOPE_BYTES,
    );
    const verified = verifyActivationAttestation({
      attestation: privateAttestation,
      integrityKey,
      validateActivityEvidence,
    });
    if (canonicalActivationAttestationDigest(verified) !== publicTrial.attestation.envelope_digest)
      throw new Error('private envelope digest does not match public attestation');
    assertPublicPrivateMatch(publicTrial, verified, expectedBinding);
    if (evidenceDigests.has(verified.evidence_digest))
      throw new Error('activation bundle reuses Activity Evidence digest');
    evidenceDigests.add(verified.evidence_digest);
    if (verified.run_id !== requiredRunId)
      throw new Error('private attestation run id does not match expected run id');
    runIds.add(verified.run_id);
  }
  if (runIds.size !== 1) throw new Error('activation bundle mixes private campaign run ids');
  // Aggregate only after private envelopes establish the release authority;
  // public artifacts provide the host-level measurements and safety fields.
  const summary = verifyActivationTrialAggregate({
    trials: publicTrials,
    expectedHosts,
    expectedRelease,
    expectedCommit,
    expectedBuildDigest,
    maxDurationMs,
  });
  return { summary, trials: publicTrials };
}

export async function verifyActivationTrialsBundle(options = {}) {
  return (await verifyActivationTrialsBundleDetailed(options)).summary;
}

/**
 * Verify the complete production host matrix without trusting per-host public
 * summaries. Each campaign is authenticated independently, then all public
 * trials are aggregated again so cross-host evidence/session reuse fails.
 */
export async function verifyProductionActivationMatrix({
  campaigns,
  integrityKey,
  expectedBinding,
  expectedRelease,
  expectedCommit,
  expectedBuildDigest,
  maxDurationMs = ACTIVATION_MAX_DURATION_MS,
  validateActivityEvidence,
} = {}) {
  assertPlainKeys(campaigns, new Set(PRODUCTION_ACTIVATION_HOSTS), 'campaigns');
  const runIds = new Set();
  const trials = [];
  for (const host of PRODUCTION_ACTIVATION_HOSTS) {
    const campaign = campaigns[host];
    assertPlainKeys(
      campaign,
      new Set(['evidenceDir', 'expectedRunId', 'inputPath']),
      `campaigns.${host}`,
    );
    const runId = assertExpectedRunId(campaign.expectedRunId);
    if (runIds.has(runId)) throw new Error('production activation matrix reuses a campaign run id');
    runIds.add(runId);
    const verified = await verifyActivationTrialsBundleDetailed({
      inputPath: campaign.inputPath,
      evidenceDir: campaign.evidenceDir,
      integrityKey,
      expectedBinding,
      expectedRunId: runId,
      expectedHosts: [host],
      expectedRelease,
      expectedCommit,
      expectedBuildDigest,
      maxDurationMs,
      validateActivityEvidence,
    });
    trials.push(...verified.trials);
  }
  return verifyActivationTrialAggregate({
    trials,
    expectedHosts: PRODUCTION_ACTIVATION_HOSTS,
    expectedRelease,
    expectedCommit,
    expectedBuildDigest,
    maxDurationMs,
  });
}

function parseCliArgs(argv) {
  const options = {
    expectedHosts: [],
  };
  const values = new Set([
    '--input',
    '--evidence-dir',
    '--expected-host',
    '--expected-release',
    '--expected-commit',
    '--expected-build-digest',
    '--expected-run-id',
  ]);
  const repeatable = new Set(['--expected-host']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!values.has(flag)) throw new Error('invalid activation verifier arguments');
    const value = argv[++index];
    if (value === undefined || value.startsWith('--') || value === '')
      throw new Error('invalid activation verifier arguments');
    const key =
      flag === '--input'
        ? 'inputPath'
        : flag === '--evidence-dir'
          ? 'evidenceDir'
          : flag === '--expected-host'
            ? 'expectedHosts'
            : flag === '--expected-release'
              ? 'expectedRelease'
              : flag === '--expected-commit'
                ? 'expectedCommit'
                : flag === '--expected-build-digest'
                  ? 'expectedBuildDigest'
                  : 'expectedRunId';
    if (repeatable.has(flag)) options[key].push(value);
    else {
      if (options[key] !== undefined) throw new Error('invalid activation verifier arguments');
      options[key] = value;
    }
  }
  if (
    typeof options.inputPath !== 'string' ||
    typeof options.evidenceDir !== 'string' ||
    options.expectedHosts.length === 0 ||
    !RELEASE_RE.test(options.expectedRelease ?? '') ||
    !COMMIT_RE.test(options.expectedCommit ?? '') ||
    !DIGEST_RE.test(options.expectedBuildDigest ?? '') ||
    !ID_RE.test(options.expectedRunId ?? '') ||
    options.expectedHosts.some((host) => !HOST_RE.test(host))
  )
    throw new Error('invalid activation verifier arguments');
  return options;
}

function publicError() {
  return JSON.stringify({
    schema_version: ACTIVATION_VERIFIER_SCHEMA,
    verified: false,
    error: 'activation verification failed',
  });
}

function activationToken(environment) {
  const value = environment.DISCORD_TOKEN?.trim();
  if (!value) throw new Error('activation verifier environment is incomplete');
  return value.startsWith('Bot ') ? value.slice(4) : value;
}

/** CLI boundary: secrets, private IDs, paths, and exception text never print. */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  try {
    const options = parseCliArgs(argv);
    const guildId = env.DISCORD_ACTIVATION_GUILD_ID;
    const botId = env.DISCORD_EXPECTED_BOT_ID;
    if (!SNOWFLAKE_RE.test(guildId ?? '') || !SNOWFLAKE_RE.test(botId ?? ''))
      throw new Error('activation verifier environment is incomplete');
    const integrityKey = activationToken(env);
    const { assertGuildBlueprintActivityEvidence } = await import('@discord-mcp/core');
    const result = await verifyActivationTrialsBundle({
      ...options,
      integrityKey,
      expectedBinding: { guildId, botId },
      validateActivityEvidence: assertGuildBlueprintActivityEvidence,
    });
    assertSecretFreeJson(result, 'activation_verifier_result');
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    stdout.write(`${publicError()}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
