import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://cappyeo.github.io',
  base: '/discord-mcp',
  integrations: [
    starlight({
      title: 'discord-mcp',
      description: 'Production-grade Discord MCP server for AI agents',
      disable404Route: true,
      favicon:
        'https://raw.githubusercontent.com/cappyeo/discord-mcp/main/site/src/assets/discord-mcp-logo-light.png',
      logo: {
        light: './src/assets/discord-mcp-logo-light.png',
        dark: './src/assets/discord-mcp-logo-dark.png',
        alt: 'Discord MCP logo',
      },
      customCss: ['./src/styles/discord-mcp.css'],
      components: {
        Hero: './src/components/DiscordMcpHero.astro',
        Header: './src/components/starlight/Header.astro',
        Sidebar: './src/components/starlight/Sidebar.astro',
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
          label: 'Start',
          items: [
            { label: 'Start here', slug: 'start' },
            'start/create-discord-bot',
            'start/quickstart',
            'start/first-tool-call',
            'start/installation',
            'start/client-setup',
            'start/troubleshooting',
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Guides overview', slug: 'recipes' },
            {
              label: 'Build workflows',
              items: [
                'recipes/moderation-bulk-ban',
                'recipes/components-v2-announcement',
                'recipes/pipeline-multistep',
                'recipes/intelligence-summarize',
                'recipes/webhook-execute',
                'recipes/gateway-subscribe',
              ],
            },
            {
              label: 'Run in production',
              collapsed: true,
              items: [
                { label: 'Operations overview', slug: 'operations' },
                'operations/configure',
                'operations/telemetry',
                'operations/resilience',
                'operations/audit',
              ],
            },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Reference overview', slug: 'reference' },
            { label: 'Tool reference', slug: 'tools' },
            {
              label: 'Messaging and community',
              collapsed: true,
              items: [
                'tools/messages',
                'tools/channels',
                'tools/threads',
                'tools/reactions',
                'tools/polls',
                'tools/webhooks',
              ],
            },
            {
              label: 'Moderation and server management',
              collapsed: true,
              items: [
                'tools/members',
                'tools/roles',
                'tools/automod',
                'tools/guild',
                'tools/invites',
                'tools/audit_log',
                'tools/onboarding',
              ],
            },
            {
              label: 'Application building',
              collapsed: true,
              items: [
                'tools/application',
                'tools/commands',
                'tools/interactions',
                'tools/components_v2',
                'tools/events',
                'tools/intelligence',
              ],
            },
            {
              label: 'Media and live experiences',
              collapsed: true,
              items: [
                'tools/emojis',
                'tools/app_emojis',
                'tools/stickers',
                'tools/soundboard',
                'tools/voice',
                'tools/stage_instances',
              ],
            },
            {
              label: 'Identity and commerce',
              collapsed: true,
              items: ['tools/users', 'tools/monetization', 'tools/meta'],
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
            'reference/cli',
            { label: 'Client capabilities', slug: 'operations/clients' },
            'reference/api-core',
            'reference/changelog',
          ],
        },
        {
          label: 'Develop',
          items: [
            { label: 'Architecture overview', slug: 'architecture' },
            { label: 'System overview', slug: 'architecture/overview' },
            'architecture/middleware-chain',
            'architecture/error-handling',
            'architecture/confirmation',
            'architecture/rate-limits',
            'architecture/components-v2',
            'architecture/pipeline',
            'architecture/sampling',
            'architecture/gateway',
            {
              label: 'Security audit archive',
              collapsed: true,
              items: [
                'operations/security-audit-2026-07-27',
                'operations/security-audit-2026-05-01',
              ],
            },
          ],
        },
      ],
    }),
  ],
});
