import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, bench, describe } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const BENCH_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_TOOL_SURFACE: 'progressive',
} as NodeJS.ProcessEnv;

let client: Client;

beforeAll(async () => {
  const config = loadConfig(BENCH_ENV);
  const logger = createLogger(config);
  const rest = new REST({
    version: '10',
    makeRequest: fetch as unknown as REST['options']['makeRequest'],
  }).setToken('fake-token');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({ rest, logger, config });
  client = new Client(
    { name: 'progressive-discovery-bench', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

describe('progressive discovery bench', () => {
  bench(
    'list advertised progressive tools',
    async () => {
      await client.listTools();
    },
    { iterations: 1_000 },
  );

  bench(
    'browse one category (compact)',
    async () => {
      await client.callTool({
        name: 'mcp_tools_search',
        arguments: { category: 'channels', limit: 8 },
      });
    },
    { iterations: 1_000 },
  );

  bench(
    'search an ambiguous outcome (compact)',
    async () => {
      await client.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'send a message', limit: 8 },
      });
    },
    { iterations: 1_000 },
  );

  bench(
    'load one exact tool contract',
    async () => {
      await client.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'messages_send' },
      });
    },
    { iterations: 1_000 },
  );
});
