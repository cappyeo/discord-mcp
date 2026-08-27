import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from './manifest.mjs';

/**
 * Private activation attestation.
 *
 * This envelope is intentionally in-memory only. Callers may persist it in a
 * private benchmark store, but this module never accepts paths or performs
 * file I/O. The public artifact should contain only the digest returned by
 * canonicalActivationAttestationDigest().
 */
export const ACTIVATION_ATTESTATION_SCHEMA = 'discord-mcp.activation-attestation.v2';
export const ACTIVATION_ATTESTATION_CONTEXT = 'discord-mcp.activation-attestation:hmac:v2';
export const ACTIVATION_ATTESTATION_ALGORITHM = 'hmac-sha256';

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'context',
  'run_id',
  'trial_id',
  'host',
  'host_version',
  'release',
  'source_commit',
  'launcher_digest',
  'binding',
  'execution_provenance',
  'profile',
  'build',
  'guild_blueprint_evidence',
  'evidence_digest',
  'baseline',
  'public_trial_digest',
  'integrity',
]);
const BINDING_KEYS = new Set(['guild_id', 'bot_id']);
const EXECUTION_PROVENANCE_KEYS = new Set([
  'execution_mode',
  'adapter_id',
  'abortable',
  'package_source',
]);
const PROFILE_KEYS = new Set(['kind', 'config_digest', 'cleanup_verified', 'token_persisted']);
const BUILD_KEYS = new Set(['cli_digest', 'core_digest', 'package_digest']);
const BASELINE_KEYS = new Set(['before_digest', 'after_digest', 'restored', 'exact']);
const INTEGRITY_KEYS = new Set(['algorithm', 'context', 'digest']);

const HOST_RE = /^[a-z][a-z0-9._-]{1,31}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const HOST_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,127}$/;
const ADAPTER_ID_RE = /^[a-z][a-z0-9._-]{2,63}$/;
const RELEASE_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_EVIDENCE_DEPTH = 12;
const MAX_EVIDENCE_KEYS = 256;

const SECRET_VALUE_RE =
  /\b(?:(?:bot|bearer)\s+[a-z0-9._-]{20,}|(?:token|authorization|api[ _.-]*key|password|cookie|secret|credential)\s*[:=]\s*\S+)/i;
const DISCORD_TOKEN_RE =
  /(?:^|[^a-z0-9_-])(?:mfa\.[a-z0-9_-]{20,}|[a-z0-9_-]{20,30}\.[a-z0-9_-]{6}\.[a-z0-9_-]{25,})(?:$|[^a-z0-9_-])/i;
const FORBIDDEN_KEY_RE =
  /(?:^|_)(?:path|file|cwd|directory|argv|command|prompt|error|stack|token|secret|authorization|password|cookie|credential)(?:$|_)/i;

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function keys(value, allowed, label) {
  if (!record(value)) throw new TypeError(`${label}: expected a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key}: unknown field`);
  }
}

function required(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key}: required`);
  return value[key];
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label}: invalid`);
  return value;
}

function digest(value, label) {
  return string(value, label, DIGEST_RE);
}

function integrityKey(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('integrityKey is required');
  return Buffer.from(value.trim(), 'utf8');
}

function scanJson(value, path = '$', depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value) || DISCORD_TOKEN_RE.test(value))
      throw new TypeError(`${path}: secret-bearing value is not allowed`);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError(`${path}: non-finite number is not allowed`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path}: only JSON values are allowed`);
  if (seen.has(value)) throw new TypeError(`${path}: cyclic values are not allowed`);
  if (depth > MAX_EVIDENCE_DEPTH) throw new TypeError(`${path}: evidence is too deeply nested`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        scanJson(item, `${path}[${index}]`, depth + 1, seen);
    } else {
      if (!record(value)) throw new TypeError(`${path}: only plain JSON objects are allowed`);
      if (Object.keys(value).length > MAX_EVIDENCE_KEYS)
        throw new TypeError(`${path}: too many fields`);
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEY_RE.test(key) && key !== 'token_persisted')
          throw new TypeError(`${path}.${key}: private envelope field is not allowed`);
        scanJson(child, `${path}.${key}`, depth + 1, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function validateEvidence(value, validateActivityEvidence) {
  if (!record(value)) throw new TypeError('guild_blueprint_evidence: expected a plain object');
  scanJson(value, 'guild_blueprint_evidence');
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES)
    throw new TypeError('guild_blueprint_evidence: outside size bound');
  if (typeof validateActivityEvidence === 'function') {
    let result;
    try {
      result = validateActivityEvidence(structuredClone(value));
    } catch {
      throw new Error('guild_blueprint_evidence validation failed');
    }
    if (result === false) throw new Error('guild_blueprint_evidence validation failed');
  }
  return value;
}

function validateEnvelope(value, { validateActivityEvidence } = {}) {
  keys(value, TOP_LEVEL_KEYS, 'activation attestation');
  if (value.schema_version !== ACTIVATION_ATTESTATION_SCHEMA)
    throw new TypeError('schema_version: unsupported activation attestation schema');
  if (value.context !== ACTIVATION_ATTESTATION_CONTEXT) throw new TypeError('context: unsupported');
  string(required(value, 'run_id', 'activation attestation'), 'run_id', ID_RE);
  string(required(value, 'trial_id', 'activation attestation'), 'trial_id', ID_RE);
  string(required(value, 'host', 'activation attestation'), 'host', HOST_RE);
  string(
    required(value, 'host_version', 'activation attestation'),
    'host_version',
    HOST_VERSION_RE,
  );
  string(required(value, 'release', 'activation attestation'), 'release', RELEASE_RE);
  string(required(value, 'source_commit', 'activation attestation'), 'source_commit', COMMIT_RE);
  digest(
    required(value, 'launcher_digest', 'activation attestation'),
    'launcher_digest',
  );

  keys(
    required(value, 'execution_provenance', 'activation attestation'),
    EXECUTION_PROVENANCE_KEYS,
    'execution_provenance',
  );
  if (!['live', 'test'].includes(value.execution_provenance.execution_mode))
    throw new TypeError('execution_provenance.execution_mode: must be live or test');
  string(value.execution_provenance.adapter_id, 'execution_provenance.adapter_id', ADAPTER_ID_RE);
  if (typeof value.execution_provenance.abortable !== 'boolean')
    throw new TypeError('execution_provenance.abortable: must be boolean');
  if (
    !['verified_npm_provenance', 'test_fixture'].includes(value.execution_provenance.package_source)
  )
    throw new TypeError(
      'execution_provenance.package_source: must be verified_npm_provenance or test_fixture',
    );

  keys(required(value, 'binding', 'activation attestation'), BINDING_KEYS, 'binding');
  string(required(value.binding, 'guild_id', 'binding'), 'binding.guild_id', SNOWFLAKE_RE);
  string(required(value.binding, 'bot_id', 'binding'), 'binding.bot_id', SNOWFLAKE_RE);

  keys(required(value, 'profile', 'activation attestation'), PROFILE_KEYS, 'profile');
  if (value.profile.kind !== 'clean_temp') throw new TypeError('profile.kind: clean_temp required');
  digest(required(value.profile, 'config_digest', 'profile'), 'profile.config_digest');
  if (value.profile.cleanup_verified !== true)
    throw new TypeError('profile.cleanup_verified: must be true');
  if (value.profile.token_persisted !== false)
    throw new TypeError('profile.token_persisted: must be false');

  keys(required(value, 'build', 'activation attestation'), BUILD_KEYS, 'build');
  for (const key of BUILD_KEYS) digest(required(value.build, key, 'build'), `build.${key}`);

  validateEvidence(
    required(value, 'guild_blueprint_evidence', 'activation attestation'),
    validateActivityEvidence,
  );
  if (
    !record(value.guild_blueprint_evidence.target) ||
    value.guild_blueprint_evidence.target.guild_id !== value.binding.guild_id ||
    value.guild_blueprint_evidence.target.bot_id !== value.binding.bot_id
  )
    throw new Error('guild_blueprint_evidence target does not match the attested binding');
  digest(value.guild_blueprint_evidence.evidence_id, 'guild_blueprint_evidence.evidence_id');
  const evidenceDigest = digest(
    required(value, 'evidence_digest', 'activation attestation'),
    'evidence_digest',
  );
  if (evidenceDigest !== canonicalActivationEvidenceDigest(value.guild_blueprint_evidence))
    throw new Error('evidence_digest does not match guild_blueprint_evidence');

  keys(required(value, 'baseline', 'activation attestation'), BASELINE_KEYS, 'baseline');
  digest(required(value.baseline, 'before_digest', 'baseline'), 'baseline.before_digest');
  digest(required(value.baseline, 'after_digest', 'baseline'), 'baseline.after_digest');
  if (value.baseline.restored !== true || value.baseline.exact !== true)
    throw new TypeError('baseline must be restored and exact');
  if (value.baseline.before_digest !== value.baseline.after_digest)
    throw new TypeError('baseline digest mismatch');

  digest(required(value, 'public_trial_digest', 'activation attestation'), 'public_trial_digest');
  return value;
}

function payloadFor(value) {
  const { integrity: ignored, ...payload } = value;
  return payload;
}

function hmac(payload, key) {
  return createHmac('sha256', integrityKey(key))
    .update(`${ACTIVATION_ATTESTATION_CONTEXT}\0${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

export function canonicalActivationEvidenceDigest(evidence) {
  validateEvidence(evidence);
  return `sha256:${createHash('sha256').update(canonicalJson(evidence), 'utf8').digest('hex')}`;
}

/** Create a private, caller-owned attestation. The input must not include integrity. */
export function createActivationAttestation({ envelope, integrityKey: key } = {}) {
  if (!record(envelope)) throw new TypeError('envelope is required');
  if (Object.hasOwn(envelope, 'integrity')) throw new TypeError('envelope.integrity is reserved');
  validateEnvelope(envelope);
  const payload = structuredClone(envelope);
  const attestation = {
    ...payload,
    integrity: {
      algorithm: ACTIVATION_ATTESTATION_ALGORITHM,
      context: ACTIVATION_ATTESTATION_CONTEXT,
      digest: hmac(payload, key),
    },
  };
  return structuredClone(attestation);
}

/** Verify shape, evidence, baseline, and HMAC without reading or writing files. */
export function verifyActivationAttestation({
  attestation,
  integrityKey: key,
  validateActivityEvidence,
} = {}) {
  if (!record(attestation)) throw new TypeError('attestation is required');
  keys(attestation, TOP_LEVEL_KEYS, 'activation attestation');
  validateEnvelope(attestation, { validateActivityEvidence });
  keys(attestation.integrity, INTEGRITY_KEYS, 'integrity');
  if (
    attestation.integrity.algorithm !== ACTIVATION_ATTESTATION_ALGORITHM ||
    attestation.integrity.context !== ACTIVATION_ATTESTATION_CONTEXT ||
    typeof attestation.integrity.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(attestation.integrity.digest)
  )
    throw new TypeError('integrity: malformed');
  const expected = Buffer.from(hmac(payloadFor(attestation), key), 'hex');
  const actual = Buffer.from(attestation.integrity.digest, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('activation attestation HMAC check failed');
  return structuredClone(attestation);
}

/** Return only a public digest; the returned value contains no private fields. */
export function canonicalActivationAttestationDigest(attestation) {
  if (!record(attestation)) throw new TypeError('attestation is required');
  scanJson(attestation);
  return `sha256:${createHash('sha256').update(canonicalJson(attestation), 'utf8').digest('hex')}`;
}
