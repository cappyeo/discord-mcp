import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const DEFAULT_GUILD_ID = '111122223333444455';

async function connect(defaultGuildId?: string): Promise<Client> {
  const config = loadConfig({
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
    ...(defaultGuildId === undefined ? {} : { DISCORD_DEFAULT_GUILD_ID: defaultGuildId }),
  } as NodeJS.ProcessEnv);
  const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({ rest, logger: createLogger(config), config });
  const client = new Client({ name: 'default-guild-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('DISCORD_DEFAULT_GUILD_ID', () => {
  let configured: Client;

  beforeAll(async () => {
    configured = await connect(DEFAULT_GUILD_ID);
  });

  afterAll(async () => {
    await configured.close();
  });

  it('publishes guild_id as optional only when a default exists', async () => {
    const configuredTools = await configured.listTools();
    const configuredGuildGet = configuredTools.tools.find((tool) => tool.name === 'guild_get');
    expect(configuredGuildGet).toBeDefined();
    expect((configuredGuildGet?.inputSchema as { required?: string[] }).required).not.toContain(
      'guild_id',
    );

    const unconfigured = await connect();
    const unconfiguredTools = await unconfigured.listTools();
    const unconfiguredGuildGet = unconfiguredTools.tools.find((tool) => tool.name === 'guild_get');
    expect((unconfiguredGuildGet?.inputSchema as { required?: string[] }).required).toContain(
      'guild_id',
    );
    await unconfigured.close();
  });

  it('uses the configured guild when a guild-scoped call omits it', async () => {
    const result = await configured.callTool({ name: 'guild_get', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ id: DEFAULT_GUILD_ID });
  });
});
