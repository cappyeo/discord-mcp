import { describe, expect, it } from 'vitest';
import { renderPreview } from './preview.js';

describe('renderPreview', () => {
  it('renders file and select controls with safe placeholders for incomplete nodes', () => {
    const out = renderPreview([
      { type: 13, file: { url: 'attachment://report.txt' } },
      { type: 13 },
      { type: 3, custom_id: 'choose' },
      { type: 8 },
      { type: 999 },
      {},
    ]);
    expect(out).toContain('File attachment://report.txt');
    expect(out).toContain('File ?');
    expect(out).toContain('Select (type 3, custom_id:choose)');
    expect(out).toContain('Select (type 8, custom_id:?)');
    expect(out).toContain('<unknown type 999>');
    expect(out).toContain('<unknown type ?>');
  });
  it('renders a TextDisplay as plain text', () => {
    const out = renderPreview([{ type: 10, content: 'hello world' }]);
    expect(out).toContain('hello world');
  });

  it('renders a Container with accent_color note', () => {
    const out = renderPreview([
      {
        type: 17,
        accent_color: 5793266,
        components: [{ type: 10, content: 'Title' }],
      },
    ]);
    expect(out).toContain('Container');
    expect(out).toContain('#5865F2');
    expect(out).toContain('Title');
  });

  it('renders a Section with Thumbnail accessory marker', () => {
    const out = renderPreview([
      {
        type: 9,
        components: [{ type: 10, content: 'Header' }],
        accessory: { type: 11, media: { url: 'https://x/y.png' } },
      },
    ]);
    expect(out).toContain('Section');
    expect(out).toContain('Header');
    expect(out).toMatch(/Thumb/i);
  });

  it('renders an ActionRow with Button labels', () => {
    const out = renderPreview([
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: 'Yes', custom_id: 'y' },
          { type: 2, style: 4, label: 'No', custom_id: 'n' },
        ],
      },
    ]);
    expect(out).toContain('[ Yes ]');
    expect(out).toContain('[ No ]');
  });

  it('renders a MediaGallery with item count', () => {
    const out = renderPreview([
      {
        type: 12,
        items: [{ media: { url: 'https://x/a.png' } }, { media: { url: 'https://x/b.png' } }],
      },
    ]);
    expect(out).toContain('MediaGallery');
    expect(out).toContain('2 items');
  });

  it('renders a Separator', () => {
    const out = renderPreview([{ type: 14, divider: true }]);
    expect(out).toMatch(/Separator|─{3,}/);
  });
});
