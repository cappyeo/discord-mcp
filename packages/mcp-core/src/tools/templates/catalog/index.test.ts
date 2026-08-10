import { describe, expect, it } from 'vitest';
import {
  type CatalogSnapshot,
  CatalogValidationError,
  createCatalogStore,
  createCatalogStoreLoader,
  parseCatalogSnapshot,
} from './index.js';

function fixture(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    schema_version: 1,
    version: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    snapshot: {
      sitemap_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ids_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source: {
        catalog: 'https://discordtemplates.me',
        sitemap: 'https://discordtemplates.me/sitemap.xml',
        code_resolution: 'authenticated website redirect',
      },
      code_snapshot_at: '2026-08-11T00:00:00.000Z',
      metadata_captured_at: '2026-08-11T00:10:00.000Z',
    },
    counts: { total: 3, active: 2, deleted: 1, unresolved: 0 },
    records: [
      {
        source_guild_id: '100000000000000001',
        code: 'gaming-main',
        availability: 'active',
        name: 'Gaming Main',
        description: 'Primary gaming structure',
        usage_count: 12,
        tags: ['gaming', 'lfg'],
      },
      {
        source_guild_id: '100000000000000002',
        code: 'community-side',
        availability: 'active',
        name: 'Community Side',
        description: null,
        usage_count: 3,
        tags: ['community'],
      },
      {
        source_guild_id: '100000000000000003',
        code: null,
        availability: 'deleted',
        name: 'Retired Template',
        description: null,
        usage_count: 0,
        tags: [],
      },
    ],
    ...overrides,
  };
}

describe('template catalog runtime foundation', () => {
  it('validates once and exposes deterministic read-only queries', () => {
    const store = createCatalogStore(fixture());

    expect(store.snapshot.counts).toEqual({ total: 3, active: 2, deleted: 1, unresolved: 0 });
    expect(store.getByCode('gaming-main')?.source_guild_id).toBe('100000000000000001');
    expect(store.getBySourceGuildId('100000000000000003')?.availability).toBe('deleted');
    expect(store.list({ availability: 'active', limit: 1 }).map((item) => item.code)).toEqual([
      'gaming-main',
    ]);
    expect(store.list().map((item) => item.source_guild_id)).toEqual([
      '100000000000000001',
      '100000000000000002',
      '100000000000000003',
    ]);

    expect(Object.isFrozen(store.snapshot)).toBe(true);
    expect(Object.isFrozen(store.snapshot.records)).toBe(true);
    expect(Object.isFrozen(store.snapshot.records[0])).toBe(true);
  });

  it('loads the generated snapshot at most once after the first successful load', () => {
    let calls = 0;
    const load = createCatalogStoreLoader(() => {
      calls += 1;
      return fixture();
    });

    const first = load();
    expect(load()).toBe(first);
    expect(load()).toBe(first);
    expect(calls).toBe(1);
  });

  it('rejects duplicate source guilds and active codes', () => {
    const records = fixture().records;
    expect(() =>
      parseCatalogSnapshot(
        fixture({
          records: [
            records[0]!,
            { ...records[1]!, source_guild_id: records[0]!.source_guild_id },
            records[2]!,
          ],
        }),
      ),
    ).toThrow(CatalogValidationError);

    expect(() =>
      parseCatalogSnapshot(
        fixture({
          records: [records[0]!, { ...records[1]!, code: records[0]!.code }, records[2]!],
        }),
      ),
    ).toThrow(/duplicate code/);
  });

  it('rejects active records with a null code and inconsistent counts', () => {
    const records = fixture().records;
    expect(() =>
      parseCatalogSnapshot(
        fixture({ records: [{ ...records[0]!, code: null }, records[1]!, records[2]!] }),
      ),
    ).toThrow(/active entries must have a valid code/);

    expect(() =>
      parseCatalogSnapshot(fixture({ counts: { total: 2, active: 2, deleted: 0, unresolved: 0 } })),
    ).toThrow(/counts must equal/);
  });

  it('rejects deleted records carrying a live code and unknown fields', () => {
    const records = fixture().records;
    expect(() =>
      parseCatalogSnapshot(
        fixture({ records: [records[0]!, records[1]!, { ...records[2]!, code: 'retired' }] }),
      ),
    ).toThrow(/deleted entries must have a null code/);

    expect(() => parseCatalogSnapshot({ ...fixture(), unexpected: true })).toThrow(/not allowed/);
  });

  it('rejects malformed nested snapshot metadata and unresolved records', () => {
    expect(() =>
      parseCatalogSnapshot({
        ...fixture(),
        version: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      }),
    ).toThrow(/version must equal/);
    expect(() =>
      parseCatalogSnapshot({
        ...fixture(),
        snapshot: { ...fixture().snapshot, sitemap_sha256: 'g'.repeat(64) },
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      parseCatalogSnapshot({
        ...fixture(),
        counts: { ...fixture().counts, unresolved: 1 },
      }),
    ).toThrow(/unresolved must be 0/);
    expect(() =>
      parseCatalogSnapshot({
        ...fixture(),
        snapshot: { ...fixture().snapshot, source: { ...fixture().snapshot.source, extra: true } },
      }),
    ).toThrow(/not allowed/);
  });
});
