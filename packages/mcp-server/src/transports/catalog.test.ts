import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCatalog } from './catalog.js';

const savedEnv = { ...process.env };

async function boot(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-transport-test', version: '0.0.0' });
  await Promise.all([
    startCatalog({ transport: serverTransport, registerSignalHandlers: false }),
    client.connect(clientTransport),
  ]);
  return client;
}

describe('startCatalog', () => {
  beforeEach(() => {
    // Catalog mode must not consult these values, even when a caller has
    // configured the normal credentialed server in the same environment.
    process.env.DISCORD_TOKEN = 'ambient-token-that-must-not-be-read';
    process.env.GATEWAY = 'true';
    process.env.OTEL_ENABLED = 'true';
    process.env.MCP_CATEGORIES = 'not-a-real-category';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('initializes over the supplied transport and exposes exactly 208 tools', async () => {
    const client = await boot();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(208);
      expect(tools.some((tool) => tool.name === 'guild_get')).toBe(true);
      expect(tools.some((tool) => tool.name === 'messages_read')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('returns CATALOG_ONLY for representative and unknown calls without Discord I/O', async () => {
    const client = await boot();
    try {
      const [representative, unknown] = await Promise.all([
        client.callTool({ name: 'guild_get', arguments: {} }),
        client.callTool({ name: 'unknown_catalog_tool', arguments: {} }),
      ]);
      for (const result of [representative, unknown]) {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            code: 'CATALOG_ONLY',
            retriable: false,
            category: 'client',
          },
        });
      }
    } finally {
      await client.close();
    }
  });
});
