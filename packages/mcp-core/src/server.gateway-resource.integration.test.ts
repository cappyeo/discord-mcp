import { EventEmitter } from 'node:events';
import type { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createGatewayClient } from './gateway/client.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const GUILD_ID = '111122223333444455';
const TOKEN = 'test-token-for-gateway-resource-suite-0000000000000000';

interface FakeGatewayClient extends EventEmitter {
  login: (token: string) => Promise<void>;
  destroy: () => Promise<void>;
  rest: { get: (path: string) => Promise<unknown> };
}

function fakeGatewayClient(): FakeGatewayClient {
  const client = new EventEmitter() as FakeGatewayClient;
  client.login = vi.fn().mockResolvedValue(undefined);
  client.destroy = vi.fn().mockResolvedValue(undefined);
  client.rest = { get: vi.fn().mockResolvedValue({ audit_log_entries: [] }) };
  return client;
}

describe('Gateway to live guild resource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('invalidates the snapshot before notifying a subscribed MCP client', async () => {
    let version = 1;
    const restGet = vi.fn(async (path: string) => {
      if (path === `/guilds/${GUILD_ID}`) {
        return { id: GUILD_ID, name: `Guild ${version}` };
      }
      return {};
    });
    const config = loadConfig({
      DISCORD_TOKEN: TOKEN,
      ALLOWED_GUILDS: GUILD_ID,
      MCP_AUDIT_SINK: 'none',
    });
    const logger = createLogger(config);
    const built = await buildServer({
      rest: { get: restGet } as unknown as REST,
      logger,
      config,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'gateway-resource-test', version: '0.0.0' },
      { capabilities: {} },
    );
    const notifications: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      notifications.push(notification.params.uri);
    });
    const gatewayClient = fakeGatewayClient();
    const gateway = createGatewayClient({
      token: TOKEN,
      registry: built.subscriptions,
      notifyResource: built.notifyResource,
      clientFactory: () => gatewayClient,
    });

    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
    const uri = `discord://guild/${GUILD_ID}/info`;
    await client.subscribeResource({ uri });
    await gateway.start();

    const first = await client.readResource({ uri });
    expect(JSON.parse(first.contents[0]!.text as string).data.name).toBe('Guild 1');
    expect(restGet).toHaveBeenCalledTimes(1);

    version = 2;
    gatewayClient.emit('guildUpdate', {}, { id: GUILD_ID });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toEqual([uri]);
    const second = await client.readResource({ uri });
    expect(JSON.parse(second.contents[0]!.text as string).data.name).toBe('Guild 2');
    expect(restGet).toHaveBeenCalledTimes(2);

    await gateway.stop();
    expect(gatewayClient.listenerCount('guildUpdate')).toBe(0);
    gatewayClient.emit('guildUpdate', {}, { id: GUILD_ID });
    await Promise.resolve();
    expect(notifications).toEqual([uri]);
    await client.close();
    await built.server.close();
  });
});
