import { describe, expect, it } from 'vitest';
import { getBundledTemplateCatalog } from './bundled.js';

describe('bundled template catalog', () => {
  it('loads the validated acquisition snapshot with active and deleted evidence', () => {
    const catalog = getBundledTemplateCatalog();

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

  it('returns the same validated store without reparsing the generated payload', () => {
    expect(getBundledTemplateCatalog()).toBe(getBundledTemplateCatalog());
  });
});
