import { createHash } from 'node:crypto';

import { assertSecretFreeJson, canonicalJson } from './manifest.mjs';

/**
 * Secret-free, host-neutral activation trial boundary.
 *
 * This artifact intentionally contains no guild/user/bot identifiers, prompt,
 * error, config, or local path. A runner may keep those details locally, but
 * they must not cross into the shareable benchmark evidence.
 */
export const ACTIVATION_ARTIFACT_SCHEMA = 'discord-mcp.activation-trial.v3';
export const ACTIVATION_ATTESTATION_REF_SCHEMA = 'discord-mcp.activation-attestation-ref.v2';

const ARTIFACT_PAYLOAD_KEYS = new Set([
  'schema_version',
  'host',
  'host_version',
  'release',
  'source_commit',
  'trial_id',
  'execution_mode',
  'result',
  'phase_durations_ms',
  'readiness',
  'terminal_status',
  'evidence',
  'digests',
  'safety',
  'baseline',
]);
const ARTIFACT_KEYS = new Set([...ARTIFACT_PAYLOAD_KEYS, 'attestation']);
const PHASE_KEYS = new Set([
  'install',
  'setup',
  'client_ready',
  'first_request',
  'apply',
  'evidence',
  'restore',
  'total',
]);
const READINESS_KEYS = new Set(['install', 'setup', 'client', 'first_request']);
const EVIDENCE_KEYS = new Set(['apply', 'guild_blueprint_evidence']);
const DIGEST_KEYS = new Set(['build', 'evidence', 'launcher', 'session']);
const SAFETY_KEYS = new Set([
  'secret_free',
  'caller_owned_bot',
  'binding_verified',
  'clean_profile',
  'isolated_session',
  'dangerous_permissions',
]);
const BASELINE_KEYS = new Set(['restored', 'exact', 'before_digest', 'after_digest']);
const ATTESTATION_KEYS = new Set(['schema_version', 'envelope_digest', 'trial_digest']);

const HOST_RE = /^[a-z][a-z0-9._-]{1,31}$/;
const RELEASE_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const TRIAL_RE = /^[a-z][a-z0-9._-]{2,63}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SNOWFLAKE_RE = /(?<!\d)\d{17,20}(?!\d)/;
const LOCAL_PATH_RE = /(?:^[A-Za-z]:[\\/])|(?:^\\\\)|(?:^\/)|(?:^\.{1,2}[\\/])|[\\/]/;
const RESULTS = new Set(['passed', 'failed']);
const EXECUTION_MODES = new Set(['live', 'test']);
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'timeout', 'blocked']);
const EVIDENCE_STATUSES = new Set(['completed', 'failed', 'blocked']);
const GUILD_EVIDENCE_STATUSES = new Set(['verified', 'failed', 'blocked']);
const READINESS_STATUSES = new Set(['ready', 'failed', 'blocked']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isRecord(value)) throw new TypeError(`${path}: expected a plain object`);
}

function assertKeys(value, allowed, path) {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key}: unknown field`);
  }
}

function assertString(value, path, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new TypeError(`${path}: invalid ${label}`);
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${path}: expected boolean`);
}

function assertStatus(value, path, statuses) {
  if (typeof value !== 'string' || !statuses.has(value))
    throw new TypeError(`${path}: invalid status`);
}

function assertDuration(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path}: invalid duration`);
}

function assertDigest(value, path) {
  assertString(value, path, DIGEST_RE, 'digest');
}

function scanPublicLabels(value) {
  for (const key of ['host', 'host_version', 'release', 'trial_id']) {
    const label = value[key];
    if (typeof label !== 'string') continue;
    if (SNOWFLAKE_RE.test(label))
      throw new TypeError(`${key}: Discord identifiers are not allowed`);
    if (LOCAL_PATH_RE.test(label)) throw new TypeError(`${key}: local paths are not allowed`);
  }
}

function validatePhaseDurations(value) {
  assertKeys(value, PHASE_KEYS, 'phase_durations_ms');
  for (const key of PHASE_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`phase_durations_ms.${key}: required`);
    assertDuration(value[key], `phase_durations_ms.${key}`);
  }
  const phases = [...PHASE_KEYS].filter((key) => key !== 'total');
  for (const key of phases) {
    if (value[key] > value.total)
      throw new TypeError(`phase_durations_ms.${key}: exceeds total duration`);
  }
  const measured = phases.reduce((total, key) => total + value[key], 0);
  if (!Number.isSafeInteger(measured) || measured > value.total)
    throw new TypeError('phase_durations_ms: sequential phases exceed total duration');
}

function validateReadiness(value) {
  assertKeys(value, READINESS_KEYS, 'readiness');
  for (const key of READINESS_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`readiness.${key}: required`);
    assertStatus(value[key], `readiness.${key}`, READINESS_STATUSES);
  }
}

function validateEvidence(value) {
  assertKeys(value, EVIDENCE_KEYS, 'evidence');
  if (!Object.hasOwn(value, 'apply')) throw new TypeError('evidence.apply: required');
  if (!Object.hasOwn(value, 'guild_blueprint_evidence'))
    throw new TypeError('evidence.guild_blueprint_evidence: required');
  assertStatus(value.apply, 'evidence.apply', EVIDENCE_STATUSES);
  assertStatus(
    value.guild_blueprint_evidence,
    'evidence.guild_blueprint_evidence',
    GUILD_EVIDENCE_STATUSES,
  );
}

function validateDigests(value) {
  assertKeys(value, DIGEST_KEYS, 'digests');
  for (const key of DIGEST_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`digests.${key}: required`);
    assertDigest(value[key], `digests.${key}`);
  }
}

function validateSafety(value) {
  assertKeys(value, SAFETY_KEYS, 'safety');
  for (const key of SAFETY_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`safety.${key}: required`);
    assertBoolean(value[key], `safety.${key}`);
  }
}

function validateBaseline(value) {
  assertKeys(value, BASELINE_KEYS, 'baseline');
  for (const key of ['restored', 'exact', 'before_digest', 'after_digest']) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`baseline.${key}: required`);
  }
  assertBoolean(value.restored, 'baseline.restored');
  assertBoolean(value.exact, 'baseline.exact');
  assertDigest(value.before_digest, 'baseline.before_digest');
  assertDigest(value.after_digest, 'baseline.after_digest');
  if (value.restored && value.exact && value.before_digest !== value.after_digest)
    throw new TypeError('baseline: restored exact baseline digest mismatch');
}

function validateAttestation(value) {
  assertKeys(value, ATTESTATION_KEYS, 'attestation');
  for (const key of ATTESTATION_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`attestation.${key}: required`);
  }
  if (value.schema_version !== ACTIVATION_ATTESTATION_REF_SCHEMA)
    throw new TypeError('attestation.schema_version: unsupported schema');
  assertDigest(value.envelope_digest, 'attestation.envelope_digest');
  assertDigest(value.trial_digest, 'attestation.trial_digest');
}

function validateActivationTrialPayload(value) {
  assertKeys(value, ARTIFACT_PAYLOAD_KEYS, '$');
  if (value.schema_version !== ACTIVATION_ARTIFACT_SCHEMA)
    throw new TypeError('schema_version: unsupported activation artifact schema');
  assertString(value.host, 'host', HOST_RE, 'host');
  assertString(value.host_version, 'host_version', RELEASE_RE, 'host version');
  assertString(value.release, 'release', RELEASE_RE, 'release');
  assertString(value.source_commit, 'source_commit', COMMIT_RE, 'source commit');
  assertString(value.trial_id, 'trial_id', TRIAL_RE, 'trial id');
  if (typeof value.execution_mode !== 'string' || !EXECUTION_MODES.has(value.execution_mode))
    throw new TypeError('execution_mode: must be live or test');
  assertStatus(value.result, 'result', RESULTS);
  validatePhaseDurations(value.phase_durations_ms);
  validateReadiness(value.readiness);
  assertStatus(value.terminal_status, 'terminal_status', TERMINAL_STATUSES);
  validateEvidence(value.evidence);
  validateDigests(value.digests);
  validateSafety(value.safety);
  validateBaseline(value.baseline);
}

export function activationTrialDigest(value) {
  assertRecord(value, '$');
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'attestation'),
  );
  const withoutSafety = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'safety'),
  );
  assertSecretFreeJson(withoutSafety);
  scanPublicLabels(payload);
  validateActivationTrialPayload(payload);
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

/** Validate and return the same artifact. Throws before any benchmark claim is trusted. */
export function assertActivationTrialArtifact(value) {
  assertRecord(value, '$');
  assertSecretFreeJson(value);
  scanPublicLabels(value);
  assertKeys(value, ARTIFACT_KEYS, '$');
  for (const key of ARTIFACT_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${key}: required`);
  }
  validateActivationTrialPayload(
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'attestation')),
  );
  validateAttestation(value.attestation);
  if (value.attestation.trial_digest !== activationTrialDigest(value))
    throw new TypeError('attestation.trial_digest: public trial digest mismatch');
  return value;
}

export function createActivationTrialArtifact(input) {
  assertActivationTrialArtifact(input);
  return structuredClone(input);
}
