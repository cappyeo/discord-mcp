import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { siteBasePath, siteHead, siteOrigin } from './src/seo';

export default defineConfig({
  site: siteOrigin,
  base: siteBasePath,
  redirects: {
    '/architecture/overview': '/discord-mcp/architecture/',
  },
  integrations: [
    starlight({
      title: 'discord-mcp',
      description: 'Production-grade Discord MCP server for AI agents',
      head: siteHead,
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
        PageTitle: './src/components/starlight/PageTitle.astro',
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
            { label: 'Unit 1 - Discord setup', slug: 'start/discord-setup' },
            { label: 'Unit 2 - Local setup', slug: 'start/local-setup' },
            { label: 'Unit 3 - Verification', slug: 'start/verify-setup' },
            { label: 'Troubleshooting', slug: 'start/troubleshooting' },
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
            { label: 'Live demo', slug: 'showcase/live-gaming-server' },
            {
              label: 'Run in production',
              collapsed: true,
              items: [
                { label: 'Production guide', slug: 'operations' },
                'operations/configure',
                'operations/credentials',
                'operations/openai',
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
                'tools/templates',
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
              label: 'Inspiration',
              collapsed: true,
              items: ['tools/inspiration'],
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
            'reference/external-documentation-review',
            'reference/v1-readiness',
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
