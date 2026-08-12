import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RawGuildTemplate } from './template.js';

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Provenance for a live Discord template inspection.
 *
 * The digest covers the bounded template identity/metadata and the complete
 * serialized source snapshot returned by Discord. Names, descriptions, and
 * permission bitfields therefore affect the audit digest, but are never
 * copied into trusted blueprint output. `fetched_at` is observational only;
 * selection never reads it, so the choice remains deterministic.
 */
export const TemplateProvenanceSchema = z.object({
  evidence_digest: z.string().regex(SHA256_DIGEST),
  fetched_at: z.string().datetime({ offset: true }),
  source_guild: z.object({
    id: z.string().regex(/^\d{17,20}$/),
    snapshot_id: z.string().nullable(),
    icon_hash: z.string().nullable(),
    preferred_locale: z.string().nullable(),
  }),
});

export type TemplateProvenance = z.infer<typeof TemplateProvenanceSchema>;

/** Stable JSON for audit digests: object key order is insignificant. */
export function canonicalTemplateJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalTemplateJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTemplateJson(item)}`)
    .join(',')}}`;
}

function digestInput(template: RawGuildTemplate): Record<string, unknown> {
  return {
    code: template.code,
    created_at: template.created_at,
    creator_id: template.creator_id,
    description: template.description,
    is_dirty: template.is_dirty ?? null,
    name: template.name,
    serialized_source_guild: template.serialized_source_guild ?? null,
    source_guild_id: template.source_guild_id,
    updated_at: template.updated_at,
    usage_count: template.usage_count,
  };
}

export function templateEvidenceDigest(template: RawGuildTemplate): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalTemplateJson(digestInput(template)))
    .digest('hex')}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function snapshotId(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

export function templateSourceGuildMetadata(template: RawGuildTemplate) {
  const source = template.serialized_source_guild ?? {};
  return {
    id: template.source_guild_id,
    snapshot_id: snapshotId(source.id),
    icon_hash: stringOrNull(source.icon_hash),
    preferred_locale: stringOrNull(source.preferred_locale),
  };
}

export function templateProvenance(
  template: RawGuildTemplate,
  fetchedAt = new Date().toISOString(),
): TemplateProvenance {
  return {
    evidence_digest: templateEvidenceDigest(template),
    fetched_at: fetchedAt,
    source_guild: templateSourceGuildMetadata(template),
  };
}
