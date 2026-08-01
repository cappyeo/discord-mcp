import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://cappyeo.github.io',
  base: '/discord-mcp',
  redirects: {
    '/architecture/overview': '/discord-mcp/architecture/',
  },
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
        PageSidebar: './src/components/starlight/PageSidebar.astro',
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
          label: 'Tutorial',
          items: [
            { label: 'Introduction', slug: 'start' },
            {
              label: '1 — Discord setup',
              items: ['start/create-discord-bot'],
            },
            {
              label: '2 — Local setup',
              items: ['start/installation', 'start/client-setup'],
            },
            {
              label: '3 — Verify your setup',
              items: ['start/quickstart', 'start/first-tool-call'],
            },
            {
              label: 'Need help?',
              collapsed: true,
              items: ['start/troubleshooting'],
            },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Workflows', slug: 'recipes' },
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
                { label: 'Production guide', slug: 'operations' },
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
            { label: 'Tools', slug: 'tools' },
            {
              label: 'Messaging',
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
              label: 'Moderation',
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
              label: 'Application',
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
              label: 'Experiences',
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
              label: 'Monetization',
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
            { label: 'Architecture', slug: 'architecture' },
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
