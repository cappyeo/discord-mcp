import { createHash } from 'node:crypto';

/** Authorization fields are transport metadata, never part of a Discord payload. */
const PAYLOAD_AUTHORIZATION_KEYS: ReadonlySet<string> = new Set([
  '__confirm',
  '__confirm_hash',
  '__confirm_id',
]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (PAYLOAD_AUTHORIZATION_KEYS.has(key)) continue;
    result[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return result;
}

/** Return a deterministic JSON representation suitable for hashing. */
export function canonicalizePayload(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/**
 * Fingerprint a caller payload without including confirmation metadata.
 * The digest is safe to show to a caller and bind a later approval to the
 * exact validated arguments that produced the preview.
 */
export function fingerprintPayload(value: unknown): string {
  return createHash('sha256').update(canonicalizePayload(value), 'utf8').digest('hex');
}
