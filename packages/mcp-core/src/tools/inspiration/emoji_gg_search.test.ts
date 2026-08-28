import { afterEach, describe, expect, it, vi } from 'vitest';
import emojiGgSearch, { resetEmojiGgCatalogCache } from './emoji_gg_search.js';

const catalog = [
  {
    id: 1,
    title: 'code_sparkle',
    slug: 'code_sparkle',
    image: 'https://cdn3.emoji.gg/emojis/code_sparkle.png',
    description: 'A sparkle for programming wins',
    license: '1',
  },
  {
    id: 2,
    title: 'cloud_ship',
    slug: 'cloud_ship',
    image: 'https://cdn3.emoji.gg/emojis/cloud_ship.gif',
    description: 'Cloud deployment',
    license: '0',
  },
  {
    id: 3,
    title: 'visual_studio_code',
    slug: 'visual_studio_code',
    image: 'https://cdn3.emoji.gg/emojis/visual_studio_code.png',
  },
  {
    id: 4,
    title: 'qrcode_think',
    slug: 'qrcode_think',
    image: 'https://cdn3.emoji.gg/emojis/qrcode_think.png',
  },
  {
    id: 5,
    title: 'unsafe',
    slug: 'unsafe',
    image: 'https://example.com/unsafe.png',
  },
  {
    id: 6,
    title: 'community_hub',
    slug: 'community_hub',
    image: 'https://cdn3.emoji.gg/emojis/community_hub.png',
    description: 'A tech community home',
  },
  {
    id: 7,
    title: 'FortniteChinese',
    slug: 'fortnite_chinese',
    image: 'https://cdn3.emoji.gg/emojis/fortnite_chinese.png',
    description: 'An unrelated third-party description that mentions tech community',
  },
  {
    id: 8,
    title: 'DannyDevito',
    slug: 'danny_devito',
    image: 'https://cdn3.emoji.gg/emojis/danny_devito.png',
  },
];

async function runSearch(query: string, limit = 8) {
  resetEmojiGgCatalogCache();
  const tool = new emojiGgSearch(
    { name: 'inspiration_emoji_gg_search', path: 'inline', root: 'inline', store: null as never },
    { name: 'inspiration_emoji_gg_search', enabled: true },
  );
  return tool.run({ query, limit }, { signal: new AbortController().signal });
}

afterEach(() => vi.unstubAllGlobals());

describe('inspiration_emoji_gg_search', () => {
  it('returns only safe Emoji.gg-hosted assets without importing anything', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = (await runSearch('code', 1)) as {
      isError: boolean;
      structuredContent: {
        candidates: Array<{ name: string; page_url: string; animated: boolean }>;
      };
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.license_review_required).toBe(true);
    expect(result.structuredContent.candidates).toEqual([
      {
        id: 1,
        name: 'code_sparkle',
        image_url: 'https://cdn3.emoji.gg/emojis/code_sparkle.png',
        page_url: 'https://emoji.gg/emoji/code_sparkle',
        animated: false,
        license_code: '1',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://emoji.gg/api',
      expect.objectContaining({
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports a provider outage distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(runSearch('cloud')).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_UNAVAILABLE',
      provider: 'Emoji.gg',
      status: 503,
    });
  });

  it('ranks a whole-word name match before incidental substrings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 })),
    );
    const result = (await runSearch('code', 3)) as {
      structuredContent: { candidates: Array<{ name: string }> };
    };
    expect(result.structuredContent.candidates.map((candidate) => candidate.name)).toEqual([
      'code_sparkle',
      'visual_studio_code',
      'qrcode_think',
    ]);
  });

  it('handles natural-language multi-word queries without trusting third-party descriptions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = (await runSearch('tech community', 3)) as {
      structuredContent: { candidates: Array<{ name: string }> };
    };

    expect(result.structuredContent.candidates[0]?.name).toBe('community_hub');
    expect(result.structuredContent.candidates.map((candidate) => candidate.name)).not.toContain(
      'FortniteChinese',
    );
    expect(result.structuredContent.candidates.map((candidate) => candidate.name)).not.toContain(
      'DannyDevito',
    );
    expect(fetchMock).toHaveBeenCalledWith('https://emoji.gg/api', expect.anything());
  });
});
