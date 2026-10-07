import { REST } from '@discordjs/rest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { BLUEPRINT_PREVIEW_RESOURCE_URI } from './apps/blueprint-preview.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildCatalogServer, buildServer } from './server.js';

const environment = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

async function connect(surface: 'full' | 'progressive', categories?: string) {
  const config = loadConfig({
    ...environment,
    MCP_TOOL_SURFACE: surface,
    ...(categories === undefined ? {} : { MCP_CATEGORIES: categories }),
  });
  const makeRequest = vi.fn(async () => Response.json({}));
  const rest = new REST({ version: '10', makeRequest }).setToken(config.DISCORD_TOKEN);
  const built = await buildServer({ rest, logger: createLogger(config), config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'blueprint-app-test', version: '0.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, makeRequest };
}

describe('MCP Apps blueprint preview', () => {
  it.each([
    'full',
    'progressive',
  ] as const)('keeps the %s tool surface and text fallback while advertising a self-contained preview', async (surface) => {
    const { client, makeRequest } = await connect(surface);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(surface === 'full' ? 222 : 7);
      const name = surface === 'full' ? 'guild_blueprint_plan' : 'build_discord_server';
      expect(tools.find((tool) => tool.name === name)?._meta).toMatchObject({
        ui: { resourceUri: BLUEPRINT_PREVIEW_RESOURCE_URI },
      });
      expect(tools.find((tool) => tool.name === 'guild_blueprint_evidence')?._meta).toMatchObject({
        ui: { resourceUri: BLUEPRINT_PREVIEW_RESOURCE_URI },
      });
      expect(tools.find((tool) => tool.name === 'guild_blueprint_apply')?._meta).toBeUndefined();
      const resources = await client.listResources();
      expect(
        resources.resources.some((resource) => resource.uri === BLUEPRINT_PREVIEW_RESOURCE_URI),
      ).toBe(true);
      const resource = await client.readResource({ uri: BLUEPRINT_PREVIEW_RESOURCE_URI });
      expect(resource.contents[0]).toMatchObject({
        uri: BLUEPRINT_PREVIEW_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
      });
      expect(resource.contents[0]!.text).toContain('<!doctype html>');
      expect(resource.contents[0]!.text).not.toMatch(/<script[^>]+src=/i);
      const result = await client.callTool({
        name,
        arguments: { request: 'build a gaming guild' },
      });
      expect(result.structuredContent).toMatchObject({ status: 'blocked', plan_token: null });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.any(String) }),
        ]),
      );
      expect(makeRequest).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('keeps the conversation preview available without exposing excluded guild tools', async () => {
    const { client, makeRequest } = await connect('progressive', 'messages');
    try {
      const resources = await client.listResources();
      expect(
        resources.resources.some((resource) => resource.uri === BLUEPRINT_PREVIEW_RESOURCE_URI),
      ).toBe(true);
      await client.readResource({ uri: BLUEPRINT_PREVIEW_RESOURCE_URI });
      const tools = (await client.listTools()).tools;
      expect(tools.some((tool) => tool.name === 'guild_change_plan')).toBe(false);
      expect(makeRequest).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('advertises the same catalog to modern UI and text clients without Discord credentials', async () => {
    const handler = createMcpHandler(async () => (await buildCatalogServer()).server);
    const clients = [false, true].map(
      (ui) =>
        new Client(
          { name: `modern-app-${ui}`, version: '0.0.0' },
          {
            versionNegotiation: { mode: 'auto' },
            capabilities: ui
              ? {
                  extensions: {
                    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
                  },
                }
              : {},
          },
        ),
    );
    try {
      for (const client of clients) {
        await client.connect(
          new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
            fetch: (url, init) => handler.fetch(new Request(url, init)),
          }),
        );
        expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
        expect(client.getDiscoverResult()?.capabilities.extensions).toMatchObject({
          'io.modelcontextprotocol/ui': {},
        });
      }
      const [textList, uiList] = await Promise.all(clients.map((client) => client.listTools()));
      expect(textList).toEqual(uiList);
      expect(uiList!.tools).toHaveLength(222);
      const read = await clients[1]!.readResource({ uri: BLUEPRINT_PREVIEW_RESOURCE_URI });
      expect(read.contents[0]!.text).toContain('<!doctype html>');
      const result = await clients[1]!.callTool({ name: 'guild_blueprint_plan', arguments: {} });
      expect(result.structuredContent).toMatchObject({ code: 'CATALOG_ONLY' });
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await handler.close();
    }
  });
});
