import { describe, expect, it, vi } from 'vitest';
import { getBundledTemplateCatalog } from './bundled.js';

describe('bundled template catalog', () => {
  it('loads the validated acquisition snapshot with active and deleted evidence', async () => {
    const catalog = await getBundledTemplateCatalog();

    expect(catalog.snapshot.version).toBe(
      'd48cec3acf16c56138b7c303d711717aabc11b0e5813865b8926c2d6952212fe',
    );
    expect(catalog.snapshot.counts).toEqual({
      total: 4_970,
      active: 4_964,
      deleted: 6,
      unresolved: 0,
    });
    expect(catalog.getByCode('WNSCpfHWnqXr')?.availability).toBe('active');
    expect(catalog.list({ availability: 'deleted' })).toHaveLength(6);
  });

  it('shares cold concurrent loads before either caller has warmed the store', async () => {
    vi.resetModules();
    const fresh = await import('./bundled.js');
    const first = fresh.getBundledTemplateCatalog();
    const second = fresh.getBundledTemplateCatalog();
    expect(first).toBe(second);
    const [firstStore, secondStore] = await Promise.all([first, second]);
    expect(firstStore).toBe(secondStore);
  });

  it('loads and validates on first use after a fresh module import', async () => {
    vi.resetModules();
    const fresh = await import('./bundled.js');
    const catalog = await fresh.getBundledTemplateCatalog();
    expect(catalog.snapshot.counts.total).toBe(4_970);
    expect(catalog.getByCode('WNSCpfHWnqXr')?.availability).toBe('active');
  });

  it('retries after a validation failure and caches the later success', async () => {
    vi.resetModules();
    let validationCalls = 0;
    vi.doMock('./index.js', async () => {
      const actual = await vi.importActual<typeof import('./index.js')>('./index.js');
      return {
        ...actual,
        createCatalogStore(input: unknown) {
          validationCalls += 1;
          if (validationCalls === 1)
            throw new actual.CatalogValidationError('transient test failure');
          return actual.createCatalogStore(input);
        },
      };
    });
    try {
      const fresh = await import('./bundled.js');
      await expect(fresh.getBundledTemplateCatalog()).rejects.toThrow('transient test failure');
      const store = await fresh.getBundledTemplateCatalog();
      expect(validationCalls).toBe(2);
      expect(await fresh.getBundledTemplateCatalog()).toBe(store);
    } finally {
      vi.doUnmock('./index.js');
      vi.resetModules();
    }
  });
});
