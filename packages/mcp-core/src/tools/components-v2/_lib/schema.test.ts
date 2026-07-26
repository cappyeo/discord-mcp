import { describe, expect, it } from 'vitest';
import { ComponentsV2Array, ComponentTypeId, ComponentV2 } from './schema.js';

describe('ComponentV2 discriminated union', () => {
  it('parses a TextDisplay (type 10)', () => {
    const r = ComponentV2.safeParse({ type: 10, content: 'hello world' });
    expect(r.success).toBe(true);
  });

  it('parses a Button (type 2) with label + custom_id', () => {
    const r = ComponentV2.safeParse({ type: 2, style: 1, label: 'Click', custom_id: 'click_me' });
    expect(r.success).toBe(true);
  });

  it('parses a link Button (style 5) with url instead of custom_id', () => {
    const r = ComponentV2.safeParse({
      type: 2,
      style: 5,
      label: 'Open',
      url: 'https://example.com',
    });
    expect(r.success).toBe(true);
  });

  it('parses a Container (type 17) with nested Section + Separator', () => {
    const r = ComponentV2.safeParse({
      type: 17,
      accent_color: 5793266,
      components: [
        {
          type: 9,
          components: [{ type: 10, content: 'Section title' }],
          accessory: { type: 11, media: { url: 'https://example.com/img.png' } },
        },
        { type: 14, divider: true, spacing: 2 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('parses a MediaGallery (type 12) with items', () => {
    const r = ComponentV2.safeParse({
      type: 12,
      items: [
        { media: { url: 'https://example.com/a.png' } },
        { media: { url: 'https://example.com/b.png' }, description: 'cap', spoiler: true },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a Container with accent_color null', () => {
    const r = ComponentV2.safeParse({
      type: 17,
      accent_color: null,
      components: [{ type: 10, content: 'hi' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a Button emoji given by id alone', () => {
    const r = ComponentV2.safeParse({
      type: 2,
      style: 1,
      custom_id: 'x',
      emoji: { id: '112233445566778899' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a Section without an accessory', () => {
    const r = ComponentV2.safeParse({ type: 9, components: [{ type: 10, content: 'hi' }] });
    expect(r.success).toBe(false);
  });

  it('rejects unknown type id', () => {
    const r = ComponentV2.safeParse({ type: 99, content: 'oops' });
    expect(r.success).toBe(false);
  });

  it('rejects TextDisplay over 4000 chars', () => {
    const r = ComponentV2.safeParse({ type: 10, content: 'x'.repeat(4001) });
    expect(r.success).toBe(false);
  });

  it('rejects Button without custom_id AND without url', () => {
    const r = ComponentV2.safeParse({ type: 2, style: 1, label: 'no-id-no-url' });
    expect(r.success).toBe(false);
  });

  it('ComponentsV2Array accepts 1-40 items', () => {
    expect(ComponentsV2Array.safeParse([{ type: 10, content: 'one' }]).success).toBe(true);
    expect(ComponentsV2Array.safeParse([]).success).toBe(false);
    const huge = Array.from({ length: 41 }, () => ({ type: 10 as const, content: 'x' }));
    expect(ComponentsV2Array.safeParse(huge).success).toBe(false);
  });

  it('ComponentTypeId enum-like helper exposes the 9 V2-specific ids', () => {
    expect(ComponentTypeId.ActionRow).toBe(1);
    expect(ComponentTypeId.Button).toBe(2);
    expect(ComponentTypeId.Section).toBe(9);
    expect(ComponentTypeId.TextDisplay).toBe(10);
    expect(ComponentTypeId.Thumbnail).toBe(11);
    expect(ComponentTypeId.MediaGallery).toBe(12);
    expect(ComponentTypeId.File).toBe(13);
    expect(ComponentTypeId.Separator).toBe(14);
    expect(ComponentTypeId.Container).toBe(17);
  });
});
