import type { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('server runtime access integration', () => {
  it('blocks a mutation before the handler when complete evidence denies it', async () => {
    const post = vi.fn();
    const rest = {
      get: vi.fn(),
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as REST;
    const config = loadConfig({
      DISCORD_TOKEN: TOKEN,
      MCP_ACCESS_MODE: 'enforce',
      LOG_LEVEL: 'fatal',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await buildServer({
      rest,
      logger: createLogger(config),
      config,
      runtimeAccessResolver: async (request) => ({
        status: 'complete',
        identityVerified: true,
        ...(request.expectedBotId === undefined ? {} : { botId: request.expectedBotId }),
        effectivePermissions: 1n << 10n, // VIEW_CHANNEL only
      }),
    });
    const client = new Client(
      { name: 'runtime-access-it', version: '0.0.0' },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: '111122223333444455', content: 'must not send' },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: 'RUNTIME_ACCESS_DENIED',
        missing_permissions: ['SEND_MESSAGES'],
      });
      expect(post).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('keeps the compatibility default advisory when no resolver is injected', async () => {
    const post = vi.fn().mockResolvedValue({
      id: '111122223333444456',
      channel_id: '111122223333444455',
      guild_id: '111122223333444455',
      content: 'compatibility path',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const rest = {
      get: vi.fn().mockResolvedValue({
        id: '987654321098765432',
        bot: true,
        username: 'test-bot',
      }),
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as REST;
    const config = loadConfig({ DISCORD_TOKEN: TOKEN, LOG_LEVEL: 'fatal' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await buildServer({ rest, logger: createLogger(config), config });
    const client = new Client(
      { name: 'runtime-access-advisory-it', version: '0.0.0' },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: '111122223333444455', content: 'compatibility path' },
      });
      expect(result.isError).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it('combines enforced user access with recipient-bound DM consent', async () => {
    const post = vi.fn().mockResolvedValue({
      id: '111122223333444456',
      type: 1,
      recipients: [{ id: '999000999000999000', username: 'recipient' }],
    });
    const rest = {
      get: vi.fn().mockResolvedValue({
        id: '987654321098765432',
        bot: true,
        username: 'test-bot',
      }),
      post,
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as REST;
    const config = loadConfig({
      DISCORD_TOKEN: TOKEN,
      DISCORD_EXPECTED_BOT_ID: '987654321098765432',
      MCP_ACCESS_MODE: 'enforce',
      MCP_DM_CONSENT_MODE: 'require',
      LOG_LEVEL: 'fatal',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await buildServer({
      rest,
      logger: createLogger(config),
      config,
      runtimeAccessResolver: async (request) => ({
        status: 'complete',
        identityVerified: true,
        ...(request.expectedBotId === undefined ? {} : { botId: request.expectedBotId }),
        effectivePermissions: 0n,
      }),
    });
    const client = new Client({ name: 'dm-consent-it', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const first = await client.callTool({
        name: 'users_create_dm',
        arguments: { recipient_id: '999000999000999000' },
      });
      expect(first.structuredContent).toMatchObject({ code: 'DM_CONSENT_REQUIRED' });
      expect(post).not.toHaveBeenCalled();
      const preview = first.structuredContent as Record<string, unknown>;
      const second = await client.callTool({
        name: 'users_create_dm',
        arguments: {
          recipient_id: '999000999000999000',
          __consent: true,
          __consent_hash: preview.consent_hash,
          __consent_id: preview.consent_id,
        },
      });
      expect(second.isError).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });
});
