/**
 * OAuth2 end-to-end: an MCP client completes the broker login (register →
 * authorize → Discord consent → callback → token), and the resulting Discord
 * user's guild permissions — not the bot's — gate each tool call.
 *
 * Discord is replaced with a loopback server and global `fetch` is redirected
 * only for the fixed Discord origin (the same seam `doctor.integration.test`
 * uses). `@discordjs/rest` ultimately issues undici requests, so a redirecting
 * `fetch` is the one interception point that does not fight the transport.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordHttp } from '../lib/oauth2.js';
import { startHttp } from './http.js';

const BOT_ID = '987654321098765432';
const CALLER_ID = '111122223333444455';
const GUILD_ID = '333344445555666677';
const CHANNEL_ID = '444455556666777788';
const CLIENT_ID = '1566823844801548491';
const CLIENT_SECRET = 'client-secret-value-with-enough-length';
const DISCORD_USER_TOKEN = 'discord-user-access-token';
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
/** Raw JSON body of each POST, for asserting what reached Discord. */
const sentBodies: Record<string, unknown>[] = [];

function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startDiscordStub(): void {
  discord = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    if (url === '/api/v10/oauth2/token' || url === '/oauth2/token') {
      json(res, { access_token: DISCORD_USER_TOKEN, token_type: 'Bearer', expires_in: 604800 });
      return;
    }
    if (url === '/api/v10/oauth2/@me') {
      json(res, {
        // The token must belong to the application the broker is configured
        // with, which is not necessarily the bot user's own ID in a stub.
        application: { id: CLIENT_ID },
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
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        sentBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      });
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
  const prefix = 'https://discord.com/api/v10/';
  const legacyOauth = 'https://discord.com/api/oauth2/token';
  if (url.startsWith(prefix)) {
    return realFetch(`${discordBase}/api/v10/${url.slice(prefix.length)}`, init);
  }
  // Discord's documented token URL omits the API version segment.
  if (url === legacyOauth) return realFetch(`${discordBase}/oauth2/token`, init);
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
  process.env.MCP_PUBLIC_URL = 'https://mcp.example.test';
  process.env.DISCORD_CLIENT_ID = CLIENT_ID;
  process.env.DISCORD_CLIENT_SECRET = CLIENT_SECRET;
  // Deliberately left at its advisory default: OAuth2 mode must enforce on its
  // own, since its whole purpose is bounding callers by their permissions.
  process.env.MCP_ACCESS_MODE = 'advisory';
  process.env.LOG_LEVEL = 'fatal';
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.DISCORD_MCP_ACCESS_TOKEN;
  delete process.env.ALLOWED_GUILDS;
  delete process.env.MCP_HTTP_MAX_IN_FLIGHT;
}

async function connect(token: string): Promise<Client> {
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

/** Complete the broker login over HTTP and return the issued access token. */
async function brokerLogin(): Promise<string> {
  const base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  const verifier = 'integration-verifier-0123456789abcdefghijkl';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const registration = (await (
    await realFetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example.test/cb'] }),
    })
  ).json()) as { client_id: string };

  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', registration.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example.test/cb');
  authorizeUrl.searchParams.set('state', 'st');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', 'identify');
  const authorize = await realFetch(authorizeUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const loginId = new URL(authorize.headers.get('location')!).searchParams.get('state')!;

  const callback = await realFetch(`${base}/oauth/callback?state=${loginId}&code=dc`, {
    redirect: 'manual',
  });
  expect(callback.status).toBe(302);
  const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;

  const tokens = (await (
    await realFetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }),
    })
  ).json()) as { access_token: string };
  return tokens.access_token;
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
  sentBodies.length = 0;
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
  it('advertises protected-resource metadata and an authorization server', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const prm = (await (
      await realFetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe('https://mcp.example.test/mcp');
    expect(prm.authorization_servers).toEqual(['https://mcp.example.test']);

    const as = (await (
      await realFetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as {
      issuer: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(as.issuer).toBe('https://mcp.example.test');
    expect(as.registration_endpoint).toBe('https://mcp.example.test/register');
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('points an unauthenticated caller at the metadata document', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const address = server.address() as AddressInfo;
    const response = await realFetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

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

  it('honours a token across a server restart when a state directory is set', async () => {
    // The deploy regression: restarting the container logged every client out.
    const stateDirectory = mkdtempSync(join(tmpdir(), 'discord-mcp-oauth-state-'));
    process.env.MCP_OAUTH_STATE_DIR = stateDirectory;
    try {
      server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
      const token = await brokerLogin();
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;

      // A second process: same directory, new in-memory state.
      server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
      expect(await httpStatus(token)).not.toBe(401);
    } finally {
      if (server !== undefined) {
        await new Promise<void>((resolve, reject) =>
          server?.close((error) => (error ? reject(error) : resolve())),
        );
        server = undefined;
      }
      delete process.env.MCP_OAUTH_STATE_DIR;
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  it('does not honour a token after a restart without a state directory', async () => {
    // Documents the default rather than asserting a desirable behaviour.
    delete process.env.MCP_OAUTH_STATE_DIR;
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const token = await brokerLogin();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;

    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    expect(await httpStatus(token)).toBe(401);
  });

  it('serves tools to a caller who completed the broker login', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect(await brokerLogin());
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
    const client = await connect(await brokerLogin());
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

  it('attributes what it sends to the authenticated caller', async () => {
    fixture = { callerRoles: [], callerPermissions: VIEW_CHANNEL | SEND_MESSAGES };
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect(await brokerLogin());
    try {
      await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: CHANNEL_ID, content: 'hello' },
      });
      // The deployment posts as one bot for everyone, so the footer is the only
      // per-caller record inside Discord.
      expect(sentBodies.at(-1)?.content).toBe('hello\n-# _Sent by @caller via discord-mcp_');
    } finally {
      await client.close();
    }
  });

  it('allows the call once the caller holds the permission', async () => {
    fixture = { callerRoles: [], callerPermissions: VIEW_CHANNEL | SEND_MESSAGES };
    server = await startHttp({ port: 0, registerSignalHandlers: false, makeRequest: stubFetch });
    const client = await connect(await brokerLogin());
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
