/**
 * Attribution reaches tool handlers through `buildServer`, so the end-to-end
 * path is exercised here: an OAuth2 caller builds a server with `buildServer`
 * exactly as the HTTP transport does, calls a write tool, and the request that
 * reaches Discord carries the credit line.
 */
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const BASE_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

const CALLER = { id: '111122223333444455', name: 'frostbun' };

async function connect(caller?: { id: string; name: string | null }): Promise<{
  client: Client;
  bodies: Record<string, unknown>[];
}> {
  const config = loadConfig(BASE_ENV);
  const bodies: Record<string, unknown>[] = [];
  const rest = new REST({
    version: '10',
    makeRequest: (async (_url: string, init: { body?: unknown }) => {
      const raw = init.body;
      // Only message posts carry the attribution; the access gate also fetches
      // the channel first.
      const isMessagePost = String(_url).endsWith('/messages');
      if (!isMessagePost) return Response.json({ guild_id: '222222222222222222' });
      // rest encodes the payload as FormData for message posts.
      if (raw instanceof FormData) {
        const payload = raw.get('payload_json');
        bodies.push(
          JSON.parse(typeof payload === 'string' ? payload : '{}') as Record<string, unknown>,
        );
      } else {
        bodies.push(raw === undefined ? {} : (JSON.parse(String(raw)) as Record<string, unknown>));
      }
      return Response.json({
        id: '999000999000999000',
        channel_id: '333333333333333333',
        content: 'ok',
        timestamp: '2026-11-03T00:00:00.000Z',
        type: 0,
        author: { id: '111111111111111111', username: 'bot', bot: true },
        attachments: [],
        embeds: [],
      });
    }) as never,
  }).setToken('fake-token');

  const { server } = await buildServer({
    rest,
    logger: createLogger(config),
    config,
    ...(caller === undefined
      ? {}
      : {
          callerPrincipalId: caller.id,
          callerPrincipalName: caller.name,
        }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'attribution-e2e', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, bodies };
}

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('attribution through buildServer', () => {
  it('credits the OAuth2 caller on a sent message', async () => {
    const { client, bodies } = await connect(CALLER);
    clients.push(client);

    await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '333333333333333333', content: 'hello' },
    });

    expect(bodies.at(-1)?.content).toBe('hello\n-# _Sent by @frostbun via discord-mcp_');
  });

  it('falls back to the account ID when Discord gave no username', async () => {
    const { client, bodies } = await connect({ id: CALLER.id, name: null });
    clients.push(client);

    await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '333333333333333333', content: 'hello' },
    });

    expect(String(bodies.at(-1)?.content)).toContain(`user \`${CALLER.id}\``);
  });

  it('adds no credit when the transport has no caller identity', async () => {
    // Shared-token deployments: there is nobody to name.
    const { client, bodies } = await connect();
    clients.push(client);

    await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '333333333333333333', content: 'hello' },
    });

    expect(bodies.at(-1)?.content).toBe('hello');
  });
});
