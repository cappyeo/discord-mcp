export const siteOrigin = 'https://cappyeo.github.io';
export const siteBasePath = '/discord-mcp';
export const docsUrl = `${siteOrigin}${siteBasePath}/`;
export const quickstartUrl = `${docsUrl}start/quickstart/`;
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
        'Documentation for discord-mcp, a local Model Context Protocol server for Discord.',
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${docsUrl}#software`,
      name: 'discord-mcp',
      alternateName: 'Discord MCP',
      url: docsUrl,
      description:
        'A local, typed Model Context Protocol server that lets MCP-compatible AI clients use a Discord bot through the Discord REST API.',
      applicationCategory: 'DeveloperApplication',
      isAccessibleForFree: true,
      license: 'https://github.com/cappyeo/discord-mcp/blob/main/LICENSE',
      downloadUrl: 'https://www.npmjs.com/package/@discord-mcp/cli',
      featureList: [
        'Typed Discord REST API tools',
        'Local stdio transport',
        'Category and confirmation safety controls',
        'OpenTelemetry and audit logging',
      ],
      sameAs: [
        'https://github.com/cappyeo/discord-mcp',
        'https://www.npmjs.com/package/@discord-mcp/cli',
        'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cappyeo/discord-mcp',
      ],
    },
  ],
};

export const siteHead = [
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
