import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const fakeEnv = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

async function connectServer(messageId: string): Promise<Client> {
  const config = loadConfig(fakeEnv);
  const rest = new REST({
    version: '10',
    makeRequest: async () => {
      await Promise.resolve();
      return Response.json({
        id: messageId,
        channel_id: '112233445566778899',
        content: 'runtime isolation',
        timestamp: '2026-08-02T10:00:00.000Z',
      });
    },
  }).setToken(config.DISCORD_TOKEN);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({ rest, logger: createLogger(config), config });
  const client = new Client(
    { name: `runtime-${messageId}`, version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('buildServer', () => {
  it('auto-discovers tools from src/tools and registers preconditions', async () => {
    const config = loadConfig(fakeEnv);
    const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
    const logger = createLogger(config);

    const { server, registeredTools, registeredPreconditions } = await buildServer({
      rest,
      logger,
      config,
    });
    expect(server).toBeDefined();
    expect(registeredTools.length).toBeGreaterThanOrEqual(1);
    expect(registeredTools).toContain('messages_send');
    expect(registeredPreconditions).toContain('category_enabled');
    expect(registeredPreconditions).toContain('confirm_required');
    expect(registeredPreconditions).toContain('explicit_guild_required');
  });

  it('keeps concurrent tool calls bound to their server runtime', async () => {
    const alpha = await connectServer('111111111111111111');
    const bravo = await connectServer('222222222222222222');

    try {
      const [alphaResult, bravoResult] = await Promise.all([
        alpha.callTool({
          name: 'messages_send',
          arguments: { channel_id: '112233445566778899', content: 'alpha' },
        }),
        bravo.callTool({
          name: 'messages_send',
          arguments: { channel_id: '112233445566778899', content: 'bravo' },
        }),
      ]);

      expect(alphaResult.structuredContent).toMatchObject({ message_id: '111111111111111111' });
      expect(bravoResult.structuredContent).toMatchObject({ message_id: '222222222222222222' });
    } finally {
      await Promise.all([alpha.close(), bravo.close()]);
    }
  });
});
