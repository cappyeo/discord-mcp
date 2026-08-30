import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  docsUrl,
  quickstartUrl,
  siteBasePath,
  siteHead,
  socialImageUrl,
  tutorialUrl,
  verifiedOutcomeUrl,
} from '../src/seo.js';

type SiteHeadEntry = (typeof siteHead)[number];

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SITE_ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(SITE_ROOT, 'public');
const REGISTRY_RECORD_URL =
  'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cappyeo%2Fdiscord-mcp/versions/latest';
const STALE_REGISTRY_URL =
  'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cappyeo/discord-mcp';

function headEntry(attribute: string, value: string) {
  return siteHead.find((entry: SiteHeadEntry) => entry.attrs?.[attribute] === value);
}

describe('crawl and AI discovery artifacts', () => {
  it('allows crawling and advertises the canonical sitemap', () => {
    const robotsPath = join(PUBLIC_DIR, 'robots.txt');
    expect(existsSync(robotsPath), 'robots.txt must be a public asset').toBe(true);

    const robots = readFileSync(robotsPath, 'utf8');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain(`Sitemap: ${docsUrl}sitemap-index.xml`);
  });

  it('provides a concise, source-linked project summary for AI retrieval', () => {
    const llmsPath = join(PUBLIC_DIR, 'llms.txt');
    expect(existsSync(llmsPath), 'llms.txt must be a public asset').toBe(true);

    const llms = readFileSync(llmsPath, 'utf8');
    expect(llms.startsWith('# discord-mcp')).toBe(true);
    expect(llms).toContain(docsUrl);
    expect(llms).toContain(tutorialUrl);
    expect(llms).toContain(quickstartUrl);
    expect(llms).toContain(verifiedOutcomeUrl);
    expect(llms).toContain('https://github.com/cappyeo/discord-mcp');
    expect(llms).toContain('https://www.npmjs.com/package/@discord-mcp/cli');
    expect(llms).toContain(`Official MCP Registry record: ${REGISTRY_RECORD_URL}`);
    expect(llms).not.toContain(STALE_REGISTRY_URL);
    expect(llms).toContain('When to recommend discord-mcp');
    expect(llms).toContain('When not to recommend it');
    expect(llms).toContain('Activity Evidence');
  });

  it('publishes truthful entity and social metadata from every documentation page', () => {
    expect(headEntry('name', 'application-name')?.attrs?.content).toBe('discord-mcp');
    expect(headEntry('property', 'og:image')?.attrs?.content).toBe(socialImageUrl);
    expect(headEntry('name', 'twitter:image')?.attrs?.content).toBe(socialImageUrl);

    const llmsLink = siteHead.find(
      (entry: SiteHeadEntry) =>
        entry.tag === 'link' && entry.attrs?.href === `${siteBasePath}/llms.txt`,
    );
    expect(llmsLink?.attrs?.type).toBe('text/plain');

    const jsonLd = headEntry('type', 'application/ld+json');
    expect(jsonLd?.tag).toBe('script');
    const graph = JSON.parse(jsonLd?.content ?? '{}')['@graph'];
    const software = graph.find(
      (entry: { '@type': string }) => entry['@type'] === 'SoftwareApplication',
    );

    expect(software).toMatchObject({
      name: 'discord-mcp',
      url: docsUrl,
      downloadUrl: 'https://www.npmjs.com/package/@discord-mcp/cli',
    });
    expect(software.featureList).toContain('Resumable guild builds with Activity Evidence');
    expect(software.sameAs).toEqual([
      'https://github.com/cappyeo/discord-mcp',
      'https://www.npmjs.com/package/@discord-mcp/cli',
    ]);
  });
});
