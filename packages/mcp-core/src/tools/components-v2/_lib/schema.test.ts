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

  it('pairs button styles with the Discord-defined credential field', () => {
    expect(
      ComponentV2.safeParse({ type: 2, style: 1, label: 'Wrong', url: 'https://x.test' }).success,
    ).toBe(false);
    expect(
      ComponentV2.safeParse({ type: 2, style: 5, label: 'Wrong', custom_id: 'x' }).success,
    ).toBe(false);
    expect(ComponentV2.safeParse({ type: 2, style: 6, sku_id: '123456789012345678' }).success).toBe(
      true,
    );
    expect(
      ComponentV2.safeParse({
        type: 2,
        style: 6,
        sku_id: '123456789012345678',
        label: 'Not allowed',
      }).success,
    ).toBe(false);
  });

  it('enforces ActionRow as up to five buttons or exactly one select', () => {
    const button = { type: 2 as const, style: 1 as const, custom_id: 'button' };
    const select = {
      type: 3 as const,
      custom_id: 'select',
      options: [{ label: 'One', value: 'one' }],
    };
    expect(ComponentsV2Array.safeParse([{ type: 1, components: [button] }]).success).toBe(true);
    expect(ComponentsV2Array.safeParse([{ type: 1, components: [select, select] }]).success).toBe(
      false,
    );
    expect(ComponentsV2Array.safeParse([{ type: 1, components: [button, select] }]).success).toBe(
      false,
    );
  });

  it('rejects child-only and attachment-backed components at the top level', () => {
    for (const component of [
      { type: 2, style: 1, custom_id: 'button' },
      { type: 3, custom_id: 'select', options: [{ label: 'One', value: 'one' }] },
      { type: 11, media: { url: 'https://example.com/thumb.png' } },
      { type: 13, file: { url: 'attachment://report.pdf' } },
    ]) {
      expect(ComponentsV2Array.safeParse([component]).success).toBe(false);
    }
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
