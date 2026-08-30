import type { StarlightConfig } from '@astrojs/starlight/types';

export const siteOrigin = 'https://cappyeo.github.io';
export const siteBasePath = '/discord-mcp';
export const docsUrl = `${siteOrigin}${siteBasePath}/`;
export const tutorialUrl = `${docsUrl}start/`;
export const quickstartUrl = `${docsUrl}start/quickstart/`;
export const verifiedOutcomeUrl = `${docsUrl}start/activity-evidence/`;
export const socialImageUrl =
  'https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-banner.jpg';

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${docsUrl}#website`,
      name: 'discord-mcp documentation',
      url: docsUrl,
      description:
        'Connect MCP-compatible AI clients to Discord through caller-owned bots, typed operations, and verifiable guild outcomes.',
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${docsUrl}#software`,
      name: 'discord-mcp',
      alternateName: 'Discord MCP',
      url: docsUrl,
      description:
        'A caller-owned Discord operations layer for MCP-compatible AI clients, with typed tools, explicit safety boundaries, resumable guild builds, and Activity Evidence.',
      applicationCategory: 'DeveloperApplication',
      isAccessibleForFree: true,
      license: 'https://github.com/cappyeo/discord-mcp/blob/main/LICENSE',
      downloadUrl: 'https://www.npmjs.com/package/@discord-mcp/cli',
      featureList: [
        '209 typed Discord operations',
        'Caller-owned bot over local stdio or authenticated HTTP',
        'Guild and category scope plus confirmation safety controls',
        'Resumable guild builds with Activity Evidence',
      ],
      sameAs: [
        'https://github.com/cappyeo/discord-mcp',
        'https://www.npmjs.com/package/@discord-mcp/cli',
      ],
    },
  ],
};

export const siteHead: StarlightConfig['head'] = [
  { tag: 'meta', attrs: { name: 'application-name', content: 'discord-mcp' } },
  { tag: 'meta', attrs: { property: 'og:image', content: socialImageUrl } },
  {
    tag: 'meta',
    attrs: {
      property: 'og:image:alt',
      content: 'Discord MCP - Connect Discord to the Model Context Protocol',
    },
  },
  { tag: 'meta', attrs: { name: 'twitter:image', content: socialImageUrl } },
  {
    tag: 'meta',
    attrs: {
      name: 'twitter:image:alt',
      content: 'Discord MCP - Connect Discord to the Model Context Protocol',
    },
  },
  {
    tag: 'link',
    attrs: {
      rel: 'alternate',
      type: 'text/plain',
      title: 'LLM-friendly project summary',
      href: `${siteBasePath}/llms.txt`,
    },
  },
  {
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    content: JSON.stringify(structuredData),
  },
];
