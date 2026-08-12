import { createHmac, timingSafeEqual } from 'node:crypto';

import { assertSecretFreeJson, canonicalJson } from './manifest.mjs';

export const SMALL_MODEL_ATTESTATION_SCHEMA = 'discord-mcp.small-model-attestation.v1';
export const SMALL_MODEL_ATTESTATION_CONTEXT = 'discord-mcp.small-model-eval:hmac:v1';
export const SMALL_MODEL_ATTESTATION_ALGORITHM = 'hmac-sha256';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKey(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('integrityKey is required');
  return Buffer.from(value.trim(), 'utf8');
}

function payloadFor(artifact) {
  if (!record(artifact)) throw new TypeError('small-model artifact is required');
  const { integrity: ignored, ...payload } = artifact;
  return payload;
}

function digestPayload(payload, integrityKey) {
  const key = createHmac('sha256', assertKey(integrityKey))
    .update(`${SMALL_MODEL_ATTESTATION_CONTEXT}\0key`, 'utf8')
    .digest();
  return createHmac('sha256', key)
    .update(`${SMALL_MODEL_ATTESTATION_CONTEXT}\0${canonicalJson(payload)}`, 'utf8')
    .digest('hex');
}

export function createSmallModelIntegrity({ artifact, integrityKey } = {}) {
  const payload = payloadFor(artifact);
  const integrity = {
    schema_version: SMALL_MODEL_ATTESTATION_SCHEMA,
    algorithm: SMALL_MODEL_ATTESTATION_ALGORITHM,
    context: SMALL_MODEL_ATTESTATION_CONTEXT,
    digest: digestPayload(payload, integrityKey),
  };
  assertSecretFreeJson(integrity);
  return integrity;
}

export function verifySmallModelIntegrity({ artifact, integrityKey } = {}) {
  if (!record(artifact) || !record(artifact.integrity)) {
    throw new Error('small-model integrity envelope is missing');
  }
  const actual = artifact.integrity;
  if (
    Object.keys(actual).sort().join('\0') !==
      ['algorithm', 'context', 'digest', 'schema_version'].join('\0') ||
    actual.schema_version !== SMALL_MODEL_ATTESTATION_SCHEMA ||
    actual.algorithm !== SMALL_MODEL_ATTESTATION_ALGORITHM ||
    actual.context !== SMALL_MODEL_ATTESTATION_CONTEXT ||
    typeof actual.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.digest)
  ) {
    throw new Error('small-model integrity envelope is malformed');
  }
  const expected = Buffer.from(digestPayload(payloadFor(artifact), integrityKey), 'hex');
  const received = Buffer.from(actual.digest, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('small-model HMAC check failed');
  }
  return artifact;
}
