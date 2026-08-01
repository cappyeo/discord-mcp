import { describe, expect, it } from 'vitest';
import { validateComponentsV2 } from './validator.js';

describe('validateComponentsV2', () => {
  it('accepts a minimal valid Container with Section', () => {
    const r = validateComponentsV2([
      {
        type: 17,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: 'hi' }],
            accessory: { type: 11, media: { url: 'https://x/y.png' } },
          },
        ],
      },
    ]);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects a Section with no accessory', () => {
    const r = validateComponentsV2([{ type: 9, components: [{ type: 10, content: 'hi' }] }]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'SECTION_NO_ACCESSORY')).toBe(true);
  });

  it('does not flag a Thumbnail used as a Section accessory', () => {
    const r = validateComponentsV2([
      {
        type: 9,
        components: [{ type: 10, content: 'hi' }],
        accessory: { type: 11, media: { url: 'https://x/y.png' } },
      },
    ]);
    expect(r.issues.some((i) => i.code === 'THUMBNAIL_STANDALONE')).toBe(false);
    expect(r.valid).toBe(true);
  });

  it('rejects a Button accessory missing both custom_id and url', () => {
    const r = validateComponentsV2([
      {
        type: 9,
        components: [{ type: 10, content: 'hi' }],
        accessory: { type: 2, style: 1, label: 'broken' } as never,
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'BUTTON_NO_ID_OR_URL')).toBe(true);
  });

  it('rejects a TextDisplay over the schema content cap', () => {
    const r = validateComponentsV2([{ type: 10, content: 'x'.repeat(6000) }]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code.startsWith('SCHEMA_'))).toBe(true);
  });

  it('rejects an ActionRow containing a TextDisplay', () => {
    const r = validateComponentsV2([
      { type: 1, components: [{ type: 10, content: 'not a button' } as never] },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code.startsWith('SCHEMA_'))).toBe(true);
  });

  it('reports an unknown component type as a single UNKNOWN_TYPE issue', () => {
    const r = validateComponentsV2([{ type: 99 } as never]);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['UNKNOWN_TYPE']);
  });

  it('rejects Container nested inside Container', () => {
    const r = validateComponentsV2([
      {
        type: 17,
        components: [{ type: 17, components: [{ type: 10, content: 'inner' }] }],
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'CONTAINER_IN_CONTAINER')).toBe(true);
  });

  it('rejects Section accessory that is neither Thumbnail nor Button', () => {
    const r = validateComponentsV2([
      {
        type: 9,
        components: [{ type: 10, content: 'x' }],
        accessory: { type: 14 } as never,
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_ACCESSORY')).toBe(true);
  });

  it('rejects total components > 40 (recursive count)', () => {
    const items = Array.from({ length: 41 }, () => ({ type: 10 as const, content: 'x' }));
    const r = validateComponentsV2(items);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'OVER_40')).toBe(true);
  });

  it('rejects Container with > 10 children', () => {
    const r = validateComponentsV2([
      {
        type: 17,
        components: Array.from({ length: 11 }, () => ({ type: 10 as const, content: 'x' })),
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'CONTAINER_OVER_10')).toBe(true);
  });

  it('rejects MediaGallery with 0 items', () => {
    expect(
      validateComponentsV2([{ type: 12, items: [] as never[] }]).issues.some(
        (i) => i.code === 'GALLERY_RANGE',
      ),
    ).toBe(true);
  });

  it('rejects ActionRow with > 5 components', () => {
    const r = validateComponentsV2([
      {
        type: 1,
        components: Array.from({ length: 6 }, (_, i) => ({
          type: 2 as const,
          style: 1,
          label: 'b',
          custom_id: `b${i}`,
        })),
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'ACTIONROW_OVER_5')).toBe(true);
  });

  it('rejects standalone Thumbnail', () => {
    const r = validateComponentsV2([{ type: 11, media: { url: 'https://x/y.png' } }] as never);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'THUMBNAIL_STANDALONE')).toBe(true);
  });

  it('rejects Button missing both custom_id and url', () => {
    const r = validateComponentsV2([
      { type: 1, components: [{ type: 2, style: 1, label: 'broken' } as never] },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'BUTTON_NO_ID_OR_URL')).toBe(true);
  });

  it('rejects duplicate custom_id values across the message tree', () => {
    const r = validateComponentsV2([
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: 'same' },
          { type: 2, style: 2, custom_id: 'same' },
        ],
      },
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'DUPLICATE_CUSTOM_ID')).toBe(true);
  });

  it('rejects File components because send/edit have no attachment input', () => {
    const r = validateComponentsV2([
      { type: 13, file: { url: 'attachment://report.pdf' } } as never,
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'FILE_UNSUPPORTED')).toBe(true);
  });

  it('issues carry path and fix_hint', () => {
    const r = validateComponentsV2([
      {
        type: 17,
        components: Array.from({ length: 11 }, () => ({ type: 10 as const, content: 'x' })),
      },
    ]);
    const overflow = r.issues.find((i) => i.code === 'CONTAINER_OVER_10');
    expect(overflow?.path).toBe('components[0]');
    expect(overflow?.fix_hint).toMatch(/split|reduce/i);
  });
});
