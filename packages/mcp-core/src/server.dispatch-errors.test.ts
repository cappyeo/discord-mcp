/**
 * Two small `server.ts` branches that had no direct assertion: an unknown tool
 * name at dispatch, and reading a resource URI the store does not know. Both
 * are user-visible error paths, not incidental internals.
 */
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

const clients: Client[] = [];

async function connect(): Promise<Client> {
  const config = loadConfig(ENV);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({
    config,
    logger: createLogger(config),
    rest: new REST({
      version: '10',
      makeRequest: (async (url: string, init: { body?: unknown }) => {
        // These paths must not reach Discord; fail loudly if one does.
        throw new Error(`unexpected Discord request: ${url} ${String(init.body)}`);
      }) as never,
    }).setToken('fake-token'),
  });
  const client = new Client({ name: 'errors-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('dispatch error paths', () => {
  it('reports an unknown tool rather than crashing the session', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'not_a_real_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not_a_real_tool');
  });

  it('reports an unknown resource URI instead of returning empty contents', async () => {
    const client = await connect();
    // The SDK wraps handler errors in a generic MCP error, so the specific
    // message stays server-side; what matters is that the read fails rather
    // than returning empty contents.
    await expect(client.readResource({ uri: 'discord-mcp://unknown' })).rejects.toThrow(
      /Internal Error/u,
    );
  });
});
