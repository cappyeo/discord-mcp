/**
 * Read-only runtime representation of the public template catalog.
 *
 * The catalog is deliberately validated at its boundary.  Recommendation
 * code should be able to trust that an `active` entry has a usable Discord
 * template code, that deleted entries cannot accidentally be selected, and
 * that the snapshot counters describe the records that were actually loaded.
 * This module does not fetch Discord or the catalog website.
 */

export const CATALOG_SCHEMA_VERSION = 1 as const;

export type CatalogAvailability = 'active' | 'deleted';

export interface CatalogRecord {
  readonly source_guild_id: string;
  readonly code: string | null;
  readonly availability: CatalogAvailability;
  readonly name: string;
  readonly description: string | null;
  readonly usage_count: number;
  readonly tags: readonly string[];
}

export interface CatalogCounts {
  readonly total: number;
  readonly active: number;
  readonly deleted: number;
  readonly unresolved: number;
}

export interface CatalogSource {
  readonly catalog: string;
  readonly sitemap: string;
  readonly code_resolution: string;
}

export interface CatalogSnapshotMetadata {
  readonly sitemap_sha256: string;
  readonly ids_sha256: string;
  readonly source: CatalogSource;
  readonly code_snapshot_at: string;
  readonly metadata_captured_at: string;
}

/** Compact schema v1 envelope emitted by the catalog builder. */
export interface CatalogSnapshot {
  readonly schema_version: typeof CATALOG_SCHEMA_VERSION;
  readonly version: string;
  readonly snapshot: CatalogSnapshotMetadata;
  readonly counts: CatalogCounts;
  readonly records: readonly CatalogRecord[];
}

export interface CatalogListOptions {
  readonly availability?: CatalogAvailability;
  readonly limit?: number;
}

export interface CatalogStore {
  /** The immutable validated snapshot metadata and records. */
  readonly snapshot: CatalogSnapshot;
  /** Look up one active template by its public discord.new code. */
  getByCode(code: string): CatalogRecord | undefined;
  /** Look up the catalog entry for one source guild. */
  getBySourceGuildId(sourceGuildId: string): CatalogRecord | undefined;
  /** Return records in deterministic source-guild order. */
  list(options?: CatalogListOptions): readonly CatalogRecord[];
}

export type CatalogStoreLoader = () => CatalogStore;

type UnknownRecord = Record<string, unknown>;

const SNAPSHOT_KEYS = new Set(['schema_version', 'version', 'snapshot', 'counts', 'records']);
const METADATA_KEYS = new Set([
  'sitemap_sha256',
  'ids_sha256',
  'source',
  'code_snapshot_at',
  'metadata_captured_at',
]);
const SOURCE_KEYS = new Set(['catalog', 'sitemap', 'code_resolution']);
const COUNTS_KEYS = new Set(['total', 'active', 'deleted', 'unresolved']);
const RECORD_KEYS = new Set([
  'source_guild_id',
  'code',
  'availability',
  'name',
  'description',
  'usage_count',
  'tags',
]);
const HASH = /^[a-f0-9]{64}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const TEMPLATE_CODE = /^[a-zA-Z0-9_-]{1,100}$/;

function object(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogValidationError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function rejectUnknownKeys(value: UnknownRecord, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CatalogValidationError(`${path}.${key} is not allowed`);
  }
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CatalogValidationError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CatalogValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function boundedString(value: unknown, path: string, min: number, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new CatalogValidationError(`${path} must be a string of length ${min}..${max}`);
  }
  return value;
}

function parseRecord(value: unknown, index: number): CatalogRecord {
  const path = `records[${index}]`;
  const raw = object(value, path);
  rejectUnknownKeys(raw, RECORD_KEYS, path);

  const sourceGuildId = boundedString(raw.source_guild_id, `${path}.source_guild_id`, 17, 20);
  if (!SNOWFLAKE.test(sourceGuildId)) {
    throw new CatalogValidationError(`${path}.source_guild_id must be a 17-20 digit snowflake`);
  }

  const availability = raw.availability;
  if (availability !== 'active' && availability !== 'deleted') {
    throw new CatalogValidationError(`${path}.availability must be active or deleted`);
  }

  const code = raw.code;
  if (code !== null && typeof code !== 'string') {
    throw new CatalogValidationError(`${path}.code must be a string or null`);
  }
  if (availability === 'active') {
    if (code === null || !TEMPLATE_CODE.test(code)) {
      throw new CatalogValidationError(`${path}.active entries must have a valid code`);
    }
  } else if (code !== null) {
    throw new CatalogValidationError(`${path}.deleted entries must have a null code`);
  }

  const name = boundedString(raw.name, `${path}.name`, 1, 256);
  const description =
    raw.description === null
      ? null
      : boundedString(raw.description, `${path}.description`, 0, 4096);

  const usageCount = nonNegativeInteger(raw.usage_count, `${path}.usage_count`);
  if (!Array.isArray(raw.tags)) {
    throw new CatalogValidationError(`${path}.tags must be an array`);
  }
  if (raw.tags.length > 16) {
    throw new CatalogValidationError(`${path}.tags must contain at most 16 items`);
  }
  const tags = raw.tags.map((tag, tagIndex) => {
    const parsed = boundedString(tag, `${path}.tags[${tagIndex}]`, 1, 64);
    return parsed;
  });
  if (new Set(tags.map((tag) => tag.trim().toLowerCase())).size !== tags.length) {
    throw new CatalogValidationError(`${path}.tags must not contain duplicates`);
  }

  return Object.freeze({
    source_guild_id: sourceGuildId,
    code,
    availability,
    name,
    description,
    usage_count: usageCount,
    tags: Object.freeze(tags),
  });
}

/**
 * Validate and freeze a compact catalog snapshot.
 *
 * No coercion is performed: malformed generated data must fail loudly at the
 * boundary instead of being silently repaired into a misleading catalog.
 */
export function parseCatalogSnapshot(value: unknown): CatalogSnapshot {
  const raw = object(value, 'catalog');
  rejectUnknownKeys(raw, SNAPSHOT_KEYS, 'catalog');

  if (raw.schema_version !== CATALOG_SCHEMA_VERSION) {
    throw new CatalogValidationError(`catalog.schema_version must be ${CATALOG_SCHEMA_VERSION}`);
  }
  const version = nonEmptyString(raw.version, 'catalog.version');
  const metadataRaw = object(raw.snapshot, 'catalog.snapshot');
  rejectUnknownKeys(metadataRaw, METADATA_KEYS, 'catalog.snapshot');
  const sitemapSha256 = boundedString(
    metadataRaw.sitemap_sha256,
    'catalog.snapshot.sitemap_sha256',
    64,
    64,
  );
  const idsSha256 = boundedString(metadataRaw.ids_sha256, 'catalog.snapshot.ids_sha256', 64, 64);
  if (!HASH.test(sitemapSha256) || !HASH.test(idsSha256)) {
    throw new CatalogValidationError(
      'catalog.snapshot hashes must be 64-character SHA-256 hex digests',
    );
  }
  if (version !== sitemapSha256) {
    throw new CatalogValidationError('catalog.version must equal catalog.snapshot.sitemap_sha256');
  }
  const sourceRaw = object(metadataRaw.source, 'catalog.snapshot.source');
  rejectUnknownKeys(sourceRaw, SOURCE_KEYS, 'catalog.snapshot.source');
  const source = {
    catalog: boundedString(sourceRaw.catalog, 'catalog.snapshot.source.catalog', 1, 2048),
    sitemap: boundedString(sourceRaw.sitemap, 'catalog.snapshot.source.sitemap', 1, 2048),
    code_resolution: boundedString(
      sourceRaw.code_resolution,
      'catalog.snapshot.source.code_resolution',
      1,
      256,
    ),
  } satisfies CatalogSource;
  const snapshot = {
    sitemap_sha256: sitemapSha256,
    ids_sha256: idsSha256,
    source: Object.freeze(source),
    code_snapshot_at: boundedString(
      metadataRaw.code_snapshot_at,
      'catalog.snapshot.code_snapshot_at',
      1,
      128,
    ),
    metadata_captured_at: boundedString(
      metadataRaw.metadata_captured_at,
      'catalog.snapshot.metadata_captured_at',
      1,
      128,
    ),
  } satisfies CatalogSnapshotMetadata;
  const countsRaw = object(raw.counts, 'catalog.counts');
  rejectUnknownKeys(countsRaw, COUNTS_KEYS, 'catalog.counts');
  const counts = {
    total: nonNegativeInteger(countsRaw.total, 'catalog.counts.total'),
    active: nonNegativeInteger(countsRaw.active, 'catalog.counts.active'),
    deleted: nonNegativeInteger(countsRaw.deleted, 'catalog.counts.deleted'),
    unresolved: nonNegativeInteger(countsRaw.unresolved, 'catalog.counts.unresolved'),
  } satisfies CatalogCounts;

  if (counts.unresolved !== 0) {
    throw new CatalogValidationError('catalog.counts.unresolved must be 0 for schema v1');
  }

  if (!Array.isArray(raw.records)) {
    throw new CatalogValidationError('catalog.records must be an array');
  }
  const records = raw.records.map(parseRecord);
  if (counts.total !== records.length || counts.active + counts.deleted !== counts.total) {
    throw new CatalogValidationError(
      'catalog.counts must equal records.length and active + deleted',
    );
  }

  const codes = new Set<string>();
  const sourceGuildIds = new Set<string>();
  let active = 0;
  let deleted = 0;
  for (const record of records) {
    if (sourceGuildIds.has(record.source_guild_id)) {
      throw new CatalogValidationError(
        `catalog.records contains duplicate source_guild_id ${record.source_guild_id}`,
      );
    }
    sourceGuildIds.add(record.source_guild_id);
    if (record.availability === 'active') {
      active += 1;
      if (record.code === null || codes.has(record.code)) {
        throw new CatalogValidationError(`catalog.records contains duplicate code ${record.code}`);
      }
      codes.add(record.code);
    } else {
      deleted += 1;
    }
  }
  if (active !== counts.active || deleted !== counts.deleted) {
    throw new CatalogValidationError('catalog.counts availability totals do not match records');
  }

  return Object.freeze({
    schema_version: CATALOG_SCHEMA_VERSION,
    snapshot: Object.freeze(snapshot),
    version,
    counts: Object.freeze(counts),
    records: Object.freeze(records),
  });
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('catalog query limit must be a non-negative safe integer');
  }
  return limit;
}

/** Build a read-only query surface over one already validated snapshot. */
export function createCatalogStore(input: unknown): CatalogStore {
  const snapshot = parseCatalogSnapshot(input);
  const byCode = new Map<string, CatalogRecord>();
  const bySourceGuildId = new Map<string, CatalogRecord>();
  const ordered = [...snapshot.records].sort((left, right) =>
    left.source_guild_id.localeCompare(right.source_guild_id),
  );
  for (const record of ordered) {
    bySourceGuildId.set(record.source_guild_id, record);
    if (record.code !== null) byCode.set(record.code, record);
  }
  const active = Object.freeze(ordered.filter((record) => record.availability === 'active'));

  return Object.freeze({
    snapshot,
    getByCode(code: string): CatalogRecord | undefined {
      return byCode.get(code);
    },
    getBySourceGuildId(sourceGuildId: string): CatalogRecord | undefined {
      return bySourceGuildId.get(sourceGuildId);
    },
    list(options: CatalogListOptions = {}): readonly CatalogRecord[] {
      const limit = normalizeLimit(options.limit);
      const records =
        options.availability === 'active'
          ? active
          : options.availability === 'deleted'
            ? Object.freeze(ordered.filter((record) => record.availability === 'deleted'))
            : ordered;
      return limit === undefined ? records : records.slice(0, limit);
    },
  });
}

/**
 * Create a lazy, once-only loader for a bundled snapshot.
 *
 * Keeping the raw JSON loader injected makes this module usable in both the
 * bundled package (where the generated JSON can be statically imported) and
 * focused tests (where a tiny fixture is supplied). A successful parse is
 * cached forever; malformed data is not cached, so a caller can retry after
 * replacing a broken deployment artifact.
 */
export function createCatalogStoreLoader(loadRaw: () => unknown): CatalogStoreLoader {
  let store: CatalogStore | undefined;
  return () => {
    if (store === undefined) store = createCatalogStore(loadRaw());
    return store;
  };
}

export class CatalogValidationError extends Error {
  override readonly name = 'CatalogValidationError';
}
