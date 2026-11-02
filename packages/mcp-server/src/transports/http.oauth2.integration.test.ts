/**
 * OAuth2 end-to-end: a Discord user access token authenticates the HTTP
 * endpoint, and that user's guild permissions — not the bot's — gate each tool
 * call.
 *
 * Discord is replaced with a loopback server and global `fetch` is redirected
 * only for the fixed Discord origin (the same seam `doctor.integration.test`
 * uses). `@discordjs/rest` ultimately issues undici requests, so a redirecting
 * `fetch` is the one interception point that does not fight the transport.
 */

import type { Server } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordHttp } from '../lib/oauth2.js';
import { startHttp } from './http.js';

const BOT_ID = '987654321098765432';
const CALLER_ID = '111122223333444455';
const GUILD_ID = '333344445555666677';
const CHANNEL_ID = '444455556666777788';
const USER_TOKEN = 'discord-user-access-token';
const BOT_TOKEN = `Bot ${'a'.repeat(60)}`;

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let discord: HttpServer;
let discordBase: string;
let server: Server | undefined;

interface DiscordFixture {
  readonly callerRoles: readonly string[];
  readonly callerPermissions: bigint;
}

let fixture: DiscordFixture = { callerRoles: [], callerPermissions: 0n };
/** Messages the bot actually sent, so a blocked call is observable. */
const sentMessages: string[] = [];

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startDiscordStub(): void {
  discord = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    if (url === '/api/v10/oauth2/@me') {
      json(res, {
        application: { id: BOT_ID },
        scopes: ['identify', 'guilds', 'guilds.members.read'],
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        user: { id: CALLER_ID, username: 'caller' },
      });
      return;
    }
    if (url === '/api/v10/users/@me') {
      json(res, { id: BOT_ID, username: 'bot', bot: true });
      return;
    }
    if (url === `/api/v10/guilds/${GUILD_ID}`) {
      json(res, { id: GUILD_ID, owner_id: '999988887777666699' });
      return;
    }
    if (url === `/api/v10/guilds/${GUILD_ID}/members/${CALLER_ID}`) {
      json(res, { user: { id: CALLER_ID }, roles: fixture.callerRoles });
      return;
    }
    if (url === `/api/v10/guilds/${GUILD_ID}/roles`) {
      json(res, [
        {
          id: GUILD_ID,
          name: '@everyone',
          position: 0,
          permissions: String(fixture.callerPermissions),
          managed: false,
        },
      ]);
      return;
    }
    if (url === `/api/v10/channels/${CHANNEL_ID}`) {
      json(res, {
        id: CHANNEL_ID,
        guild_id: GUILD_ID,
        type: 0,
        permission_overwrites: [],
      });
      return;
    }
    if (req.method === 'POST' && url === `/api/v10/channels/${CHANNEL_ID}/messages`) {
      sentMessages.push('sent');
      json(res, {
        id: '555566667777888899',
        channel_id: CHANNEL_ID,
        content: 'hello',
        type: 0,
        timestamp: '2026-11-02T00:00:00.000Z',
        author: { id: BOT_ID, username: 'bot', bot: true },
        attachments: [],
        embeds: [],
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found', code: 0 }));
  });
}

/** Loopback-substituting HTTP client handed to the transport. */
const stubFetch: DiscordHttp = ((input: string, init: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://discord.com/api/v10/')) {
    return realFetch(
      `${discordBase}/api/v10/${url.slice('https://discord.com/api/v10/'.length)}`,
      init,
    );
  }
  return realFetch(input, init);
}) as unknown as DiscordHttp;

async function listen(): Promise<void> {
  // Executor form, not Promise.withResolvers: this package's tsconfig lib
  // predates ES2024 (same as every other suite here).
  await new Promise<void>((resolve) => discord.listen(0, '127.0.0.1', resolve));
  discordBase = `http://127.0.0.1:${(discord.address() as AddressInfo).port}`;
}

function configureEnv(): void {
  process.env.DISCORD_TOKEN = BOT_TOKEN;
  process.env.DISCORD_EXPECTED_BOT_ID = BOT_ID;
  process.env.MCP_AUTH_MODE = 'oauth2';
  // Deliberately left at its advisory default: OAuth2 mode must enforce on its
  // own, since its whole purpose is bounding callers by their permissions.
  process.env.MCP_ACCESS_MODE = 'advisory';
  process.env.LOG_LEVEL = 'fatal';
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.DISCORD_MCP_ACCESS_TOKEN;
  delete process.env.ALLOWED_GUILDS;
  delete process.env.MCP_HTTP_MAX_IN_FLIGHT;
}

async function connect(token = USER_TOKEN): Promise<Client> {
  const address = server?.address() as AddressInfo | null;
  if (address === null || address === undefined) throw new Error('HTTP server is not listening');
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: 'oauth2-it', version: '0.0.0' });
  await client.connect(transport as never);
  return client;
}

function httpStatus(token: string): Promise<number> {
  const address = server?.address() as AddressInfo;
  return realFetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }).then((response) => response.status);
}

beforeAll(async () => {
  startDiscordStub();
  await listen();
});

beforeEach(() => {
  fixture = { callerRoles: [], callerPermissions: 0n };
  sentMessages.length = 0;
  configureEnv();
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  process.env = { ...savedEnv };
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    discord.close((error) => (error ? reject(error) : resolve())),
  );
  process.env = { ...savedEnv };
});

describe('OAuth2 HTTP authentication', () => {
  it('rejects requests without a bearer token', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    expect(await httpStatus('')).toBe(401);
  });

  it('keeps readiness reachable for infrastructure probes', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const address = server.address() as AddressInfo;
    const response = await realFetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(200);
  });

  it('serves tools to an allowlisted caller', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('messages_send');
    } finally {
      await client.close();
    }
  });

  it('blocks a call the caller cannot perform, even though the bot can', async () => {
    // Bot keeps every permission; the caller only sees the channel.
    fixture = { callerRoles: [], callerPermissions: VIEW_CHANNEL };
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: CHANNEL_ID, content: 'must not send' },
      });
      expect(result.structuredContent).toMatchObject({
        code: 'RUNTIME_ACCESS_DENIED',
        missing_permissions: ['SEND_MESSAGES'],
      });
      expect(sentMessages).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('allows the call once the caller holds the permission', async () => {
    fixture = { callerRoles: [], callerPermissions: VIEW_CHANNEL | SEND_MESSAGES };
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: CHANNEL_ID, content: 'hello' },
      });
      expect(result.isError).toBeFalsy();
      expect(sentMessages).toEqual(['sent']);
    } finally {
      await client.close();
    }
  });
});
