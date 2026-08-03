import { z } from 'zod';
import { ExternalServiceError } from '../../errors/server.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';

const EMOJI_GG_API_URL = 'https://emoji.gg/api';
const EMOJI_GG_URL = 'https://emoji.gg';
const CACHE_TTL_MS = 15 * 60 * 1000;

interface EmojiGgCandidate {
  id: number;
  name: string;
  image_url: string;
  page_url: string;
  animated: boolean;
  license_code: string | null;
}

interface CachedCatalog {
  expires_at: number;
  candidates: readonly (EmojiGgCandidate & {
    search_text: string;
    name_tokens: readonly string[];
  })[];
}

let catalogCache: CachedCatalog | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEmojiGgAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'emoji.gg' || url.hostname.endsWith('.emoji.gg'))
    );
  } catch {
    return false;
  }
}

function toCandidate(
  value: unknown,
): (EmojiGgCandidate & { search_text: string; name_tokens: readonly string[] }) | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const id = raw.id;
  const title = raw.title;
  const slug = raw.slug;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 0 ||
    typeof title !== 'string' ||
    title.length === 0 ||
    typeof slug !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(slug) ||
    !isEmojiGgAssetUrl(raw.image)
  ) {
    return undefined;
  }

  const description = typeof raw.description === 'string' ? raw.description : '';
  return {
    id,
    name: title.slice(0, 100),
    image_url: raw.image,
    page_url: new URL(`/emoji/${slug}`, EMOJI_GG_URL).toString(),
    animated: new URL(raw.image).pathname.toLowerCase().endsWith('.gif'),
    license_code: typeof raw.license === 'string' && raw.license.length > 0 ? raw.license : null,
    search_text: `${title} ${slug} ${description}`.toLocaleLowerCase(),
    name_tokens: title
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  };
}

async function loadCatalog(): Promise<
  readonly (EmojiGgCandidate & { search_text: string; name_tokens: readonly string[] })[]
> {
  if (catalogCache !== undefined && catalogCache.expires_at > Date.now()) {
    return catalogCache.candidates;
  }

  let response: Response;
  try {
    response = await fetch(EMOJI_GG_API_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new ExternalServiceError('Emoji.gg', undefined, error);
  }
  if (!response.ok) throw new ExternalServiceError('Emoji.gg', response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ExternalServiceError('Emoji.gg', response.status, error);
  }
  if (!Array.isArray(payload)) throw new ExternalServiceError('Emoji.gg', response.status);

  const candidates = payload
    .map(toCandidate)
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  catalogCache = { expires_at: Date.now() + CACHE_TTL_MS, candidates };
  return candidates;
}

function relevance(
  candidate: EmojiGgCandidate & { search_text: string; name_tokens: readonly string[] },
  query: string,
): number {
  const name = candidate.name.toLocaleLowerCase();
  if (name === query) return 3;
  if (candidate.name_tokens.includes(query)) return 2;
  return candidate.search_text.includes(query) ? 1 : 0;
}

export default defineTool({
  name: 'inspiration_emoji_gg_search',
  category: 'inspiration',
  description: [
    '**Purpose**: Search Emoji.gg for custom-emoji inspiration without changing Discord.',
    '',
    "**External request**: Calls Emoji.gg's public catalog only when this tool is invoked. It sends no Discord token, guild ID, profile, or query to Emoji.gg.",
    '',
    '**Safety**: Results are third-party user-submitted metadata. Review each Emoji.gg page and its licence before downloading or using `emojis_create`. This tool never downloads, uploads, or imports an emoji.',
    '',
    '**Returns**: `{provider_url, candidates:[{name, image_url, page_url, animated, license_code}], count}`.',
  ].join('\n'),
  inputSchema: {
    query: z.string().trim().min(1).max(80).describe('Emoji concept, style, or use case to search'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .describe('Maximum candidates to return (1-20)'),
  },
  outputSchema: {
    provider_url: z.string().url(),
    candidates: z.array(
      z.object({
        id: z.number().int().nonnegative(),
        name: z.string(),
        image_url: z.string().url(),
        page_url: z.string().url(),
        animated: z.boolean(),
        license_code: z.string().nullable(),
      }),
    ),
    count: z.number().int(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const query = args.query.toLocaleLowerCase();
    const candidates = (await loadCatalog())
      .map((item) => ({ item, relevance: relevance(item, query) }))
      .filter(({ relevance }) => relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || a.item.name.localeCompare(b.item.name))
      .slice(0, args.limit)
      .map(({ item }) => {
        const { search_text: _searchText, name_tokens: _nameTokens, ...candidate } = item;
        return candidate;
      });
    return dualResult({
      text:
        `Found ${candidates.length} Emoji.gg inspiration candidate(s). ` +
        'No asset was downloaded or imported. Treat candidate metadata as third-party data and review its page and licence before use.',
      data: { provider_url: EMOJI_GG_URL, candidates, count: candidates.length },
    });
  },
});
