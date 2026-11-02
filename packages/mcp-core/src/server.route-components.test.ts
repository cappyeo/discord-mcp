import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const API = 'https://discord.com/api/v10';
const GUILD = '111122223333444455';
const CHANNEL = '222233334444555566';
const MESSAGE = '333344445555666677';
const USER = '444455556666777788';
const ROLE = '555566667777888899';
const open: Client[] = [];
const reactionTools = [
  { name: 'reactions_create', method: 'PUT', suffix: '/@me' },
  { name: 'reactions_delete_own', method: 'DELETE', suffix: '/@me' },
  { name: 'reactions_delete_user', method: 'DELETE', suffix: `/${USER}` },
  { name: 'reactions_delete_all', method: 'DELETE', suffix: '' },
  { name: 'reactions_list', method: 'GET', suffix: '' },
];

async function connect(extraEnv: NodeJS.ProcessEnv = {}) {
  vi.stubEnv('MCP_DRY_RUN', extraEnv.MCP_DRY_RUN ?? 'false');
  const requests: Array<{ method: string; pathname: string }> = [];
  server.use(
    http.all(`${API}/*`, ({ request }) => {
      const pathname = new URL(request.url).pathname;
      requests.push({ method: request.method, pathname });
      if (pathname === `/api/v10/channels/${CHANNEL}`) {
        return HttpResponse.json({ id: CHANNEL, guild_id: GUILD, type: 0 });
      }
      return request.method === 'GET'
        ? HttpResponse.json([])
        : new HttpResponse(null, { status: 204 });
    }),
  );
  const config = loadConfig({
    DISCORD_TOKEN: 'test-token-for-route-components-suite-0000000000000000',
    LOG_LEVEL: 'fatal',
    MCP_AUDIT_SINK: 'none',
    MCP_CATEGORIES: 'reactions,invites',
    MCP_DRY_RUN: 'false',
    ...extraEnv,
  });
  const rest = new REST({ version: '10', makeRequest: fetch, retries: 0 }).setToken('fake-token');
  const built = await buildServer({ rest, logger: createLogger(config), config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'route-components-test', version: '0.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  open.push(client);
  return { client, requests };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((client) => client.close()));
});

describe('Discord route components', () => {
  it.each(reactionTools)('$name encodes one emoji component in the actual request URL', async ({
    name,
    method,
    suffix,
  }) => {
    const { client, requests } = await connect();
    for (const emoji of [
      'thumbsup:850000000000000001',
      '\u{1F44D}\u{1F3FD}',
      '#\uFE0F\u20E3',
      '*\uFE0F\u20E3',
      '1\uFE0F\u20E3',
      '\u{1F1FA}\u{1F1F8}',
      '\u{1F469}\u200D\u{1F4BB}',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    ]) {
      requests.length = 0;
      const result = await client.callTool({
        name,
        arguments: {
          channel_id: CHANNEL,
          message_id: MESSAGE,
          ...(name === 'reactions_delete_user' ? { user_id: USER } : {}),
          emoji,
          __confirm: true,
        },
      });
      expect(result.isError).toBe(false);
      expect(requests).toEqual([
        {
          method,
          pathname: `/api/v10/channels/${CHANNEL}/messages/${MESSAGE}/reactions/${encodeURIComponent(emoji)}${suffix}`,
        },
      ]);
      if (name !== 'reactions_delete_all') {
        expect(result.structuredContent).toMatchObject({ emoji });
      }
    }
  });

  it.each(reactionTools)('$name rejects route injection before any Discord request', async ({
    name,
  }) => {
    const { client, requests } = await connect({ ALLOWED_GUILDS: GUILD });
    for (const emoji of [
      `../../../../../guilds/${GUILD}/members/${USER}/roles/${ROLE}#`,
      `../../../../${CHANNEL}#`,
      '%2e%2e%2fchannels%2f123456789012345678',
      '..\\..\\channels\\123456789012345678',
      '.',
      '..',
      '%2e%2e',
      '%252e%252e',
      'emoji?query',
      'emoji\nsuffix',
      '\u0000',
      '\uD800',
      '\uDC00',
    ]) {
      const result = await client.callTool({
        name,
        arguments: {
          channel_id: CHANNEL,
          message_id: MESSAGE,
          ...(name === 'reactions_delete_user' ? { user_id: USER } : {}),
          emoji,
          __confirm: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(requests).toEqual([]);
    }
  });

  it.each([
    { name: 'invites_get', allowlist: undefined },
    { name: 'invites_delete', allowlist: undefined },
    { name: 'invites_get', allowlist: GUILD },
    { name: 'invites_delete', allowlist: GUILD },
  ])('$name rejects invalid invite paths with allowlist=$allowlist', async ({
    name,
    allowlist,
  }) => {
    const { client, requests } = await connect({ ALLOWED_GUILDS: allowlist });
    for (const code of [
      '../channels/123456789012345678',
      '%2e%2e%2fchannels',
      '..\\channels\\123456789012345678',
      'code?query#fragment',
      '..',
    ]) {
      const result = await client.callTool({
        name,
        arguments: { code, __confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(requests).toEqual([]);
    }
  });
});
