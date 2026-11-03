/**
 * Guild-scoped channel enumeration is authorized by the bot credential, so an
 * OAuth2 caller without VIEW_CHANNEL would otherwise learn channel names it
 * cannot see. This exercises the real server path, not the helper.
 */
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { buildServer } from '../../server.js';

const GUILD = '111122223333444455';
const CALLER = '111122223333444466';
const VIEWER_ROLE = '111122223333444477';
const PRIVATE = '111122223333444488';
const PUBLIC = '111122223333444499';

const BASE_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

function restFor(callerRoleIds: string[]): REST {
  const body = (url: string): unknown => {
    const path = new URL(url).pathname;
    if (path === `/api/v10/guilds/${GUILD}`) return { id: GUILD, owner_id: '111122223333444400' };
    if (path === `/api/v10/guilds/${GUILD}/members/${CALLER}`) return { roles: callerRoleIds };
    if (path === `/api/v10/guilds/${GUILD}/roles`)
      return [
        { id: GUILD, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: VIEWER_ROLE,
          name: 'viewer',
          position: 1,
          // ViewChannel
          permissions: '1024',
          managed: false,
        },
      ];
    if (path === `/api/v10/guilds/${GUILD}/channels`)
      return [
        {
          id: PUBLIC,
          name: 'general',
          type: 0,
          position: 0,
          parent_id: null,
          permission_overwrites: [],
        },
        {
          id: PRIVATE,
          name: 'finance',
          type: 0,
          position: 1,
          parent_id: null,
          // Deny ViewChannel to the viewer role only; the caller lacks it.
          permission_overwrites: [
            { id: VIEWER_ROLE, type: 0, allow: '0', deny: '1024' },
            { id: '111122223333444411', type: 1, allow: '1024', deny: '0' },
          ],
        },
      ];
    throw new Error(`unexpected route ${path}`);
  };
  return new REST({
    version: '10',
    makeRequest: (async (url: string) => Response.json(body(url))) as never,
  }).setToken('fake-token');
}

async function listChannels(callerId?: string): Promise<{
  text: string;
  names: string[];
}> {
  const config = loadConfig(BASE_ENV);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({
    rest: restFor([VIEWER_ROLE]),
    logger: createLogger(config),
    config,
    ...(callerId === undefined ? {} : { callerPrincipalId: callerId }),
  });
  const client = new Client({ name: 'visibility-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: 'channels_list',
      arguments: { guild_id: GUILD },
    });
    const structured = result.structuredContent as { channels: Array<{ name: string }> };
    const text = (result.content as Array<{ text?: string }>)
      .map((part) => part.text ?? '')
      .join('\n');
    return { text, names: structured.channels.map((channel) => channel.name) };
  } finally {
    await client.close();
  }
}

describe('channels_list caller visibility', () => {
  it('hides channels the OAuth2 caller cannot view', async () => {
    const { text, names } = await listChannels(CALLER);
    expect(names).toEqual(['general']);
    expect(text).not.toContain('finance');
  });

  it('keeps the bot view when no end user is acting', async () => {
    const { names } = await listChannels();
    expect(names).toEqual(['general', 'finance']);
  });

  it('hides everything when the caller is not a guild member', async () => {
    const config = loadConfig(BASE_ENV);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const rest = new REST({
      version: '10',
      makeRequest: (async (url: string) => {
        if (new URL(url).pathname.endsWith(`/members/${CALLER}`))
          return Response.json({ message: 'Unknown Member' }, { status: 404 });
        return Response.json({
          id: GUILD,
          owner_id: '111122223333444400',
          roles: [],
          channels: [{ id: PUBLIC, name: 'general', type: 0, position: 0, parent_id: null }],
        });
      }) as never,
    }).setToken('fake-token');
    const { server } = await buildServer({
      rest,
      logger: createLogger(config),
      config,
      callerPrincipalId: CALLER,
    });
    const client = new Client({ name: 'visibility-test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'channels_list',
        arguments: { guild_id: GUILD },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('finance');
    } finally {
      await client.close();
    }
  });
});
