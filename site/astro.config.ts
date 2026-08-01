import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://cappyeo.github.io',
  base: '/discord-mcp',
  integrations: [
    starlight({
      title: 'discord-mcp',
      description: 'Production-grade Discord MCP server for AI agents',
      logo: {
        light: './src/assets/discord-mcp-logo-light.png',
        dark: './src/assets/discord-mcp-logo-dark.png',
        alt: 'Discord MCP logo',
      },
      customCss: ['./src/styles/discord-mcp.css'],
      components: {
        Hero: './src/components/DiscordMcpHero.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/cappyeo/discord-mcp/edit/main/site/',
      },
      lastUpdated: true,
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/cappyeo/discord-mcp',
        },
      ],
      sidebar: [
        {
          label: 'Get started',
          items: ['start', 'start/quickstart', 'start/installation', 'start/client-setup', 'start/first-tool-call'],
        },
        {
          label: 'Use discord-mcp',
          collapsed: true,
          items: [
            { label: 'Tools (192)', autogenerate: { directory: 'tools', collapsed: true } },
            { label: 'Recipes', autogenerate: { directory: 'recipes', collapsed: true } },
          ],
        },
        {
          label: 'Run in production',
          collapsed: true,
          items: [
            'operations',
            'operations/configure',
            {
              label: 'Operational guides',
              collapsed: true,
              items: [
                'operations/telemetry',
                'operations/resilience',
                'operations/audit',
                'operations/clients',
                'operations/security-audit-2026-07-27',
                'operations/security-audit-2026-05-01',
              ],
            },
            {
              label: 'Environment variables',
              collapsed: true,
              items: [
                'reference/config',
                'reference/config/access',
                'reference/config/safety',
                'reference/config/runtime',
                'reference/config/observability',
                'reference/config/resilience',
                'reference/config/audit',
              ],
            },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: ['reference', 'reference/cli', 'reference/api-core', 'reference/changelog'],
        },
        {
          label: 'Advanced',
          collapsed: true,
          items: [
            { label: 'Architecture', autogenerate: { directory: 'architecture', collapsed: true } },
            { label: 'Migrate', autogenerate: { directory: 'migrate', collapsed: true } },
          ],
        },
      ],
    }),
  ],
});
