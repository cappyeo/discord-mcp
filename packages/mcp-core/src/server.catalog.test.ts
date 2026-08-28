import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildCatalogServer, buildServer } from './server.js';

const fakeEnv = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

async function connect(
  server: Awaited<ReturnType<typeof buildCatalogServer>>['server'],
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('buildCatalogServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the exact full live tool surface without reading ambient credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const previous = {
      DISCORD_TOKEN: process.env.DISCORD_TOKEN,
      GATEWAY: process.env.GATEWAY,
      OTEL_ENABLED: process.env.OTEL_ENABLED,
      MCP_CATEGORIES: process.env.MCP_CATEGORIES,
    };
    process.env.DISCORD_TOKEN = 'ambient-token';
    process.env.GATEWAY = 'true';
    process.env.OTEL_ENABLED = 'true';
    process.env.MCP_CATEGORIES = 'not-a-real-category';

    try {
      const catalogBuilt = await buildCatalogServer();
      const catalogClient = await connect(catalogBuilt.server);

      const config = loadConfig(fakeEnv);
      const rest = new REST({ version: '10', makeRequest: fetch }).setToken(config.DISCORD_TOKEN);
      const liveBuilt = await buildServer({ rest, logger: createLogger(config), config });
      const liveClient = await connect(liveBuilt.server);

      const catalog = await catalogClient.listTools();
      const live = await liveClient.listTools();
      expect(catalog.tools).toHaveLength(209);
      expect(normalized(catalog.tools)).toEqual(normalized(live.tools));
      expect(fetchSpy).not.toHaveBeenCalled();

      await Promise.all([catalogClient.close(), liveClient.close()]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('fails every listed and unknown tool call before validation or Discord I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const built = await buildCatalogServer();
    const client = await connect(built.server);
    const { tools } = await client.listTools();

    const results = await Promise.all([
      ...tools.map((tool) => client.callTool({ name: tool.name, arguments: {} })),
      client.callTool({ name: 'unknown_catalog_tool', arguments: {} }),
    ]);

    expect(results).toHaveLength(210);
    for (const result of results) {
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'CATALOG_ONLY',
          retriable: false,
          category: 'client',
        },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close();
  });
});
