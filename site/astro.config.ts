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
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/cappyeo/discord-mcp',
        },
      ],
      sidebar: [
        { label: 'Get started', autogenerate: { directory: 'start' } },
        { label: 'Tools (192)', autogenerate: { directory: 'tools', collapsed: true } },
        { label: 'Recipes', autogenerate: { directory: 'recipes' } },
        { label: 'Operations', autogenerate: { directory: 'operations' } },
        { label: 'Architecture', autogenerate: { directory: 'architecture' } },
        { label: 'Migrate', autogenerate: { directory: 'migrate' } },
        { label: 'Reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
});
