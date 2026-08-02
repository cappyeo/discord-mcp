import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHttp } from './http.js';

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;
const ACCESS_TOKEN = 'test-access-token';
const savedEnv = { ...process.env };

let server: Server | undefined;

function endpoint(): URL {
  const address = server?.address() as AddressInfo | null;
  if (address === null || address === undefined) throw new Error('HTTP server is not listening');
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function closeServer(): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
}

beforeEach(() => {
  process.env.DISCORD_TOKEN = VALID_TOKEN;
  process.env.DISCORD_MCP_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.LOG_LEVEL = 'fatal';
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.DISCORD_EXPECTED_BOT_ID;
});

afterEach(async () => {
  await closeServer();
  process.env = { ...savedEnv };
});

describe('startHttp', () => {
  it('rejects unauthenticated MCP requests', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false });

    const response = await fetch(endpoint(), { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('keeps authenticated 2025-era Streamable HTTP clients compatible', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const transport = new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    });
    const client = new Client({ name: 'http-test', version: '0.0.0' });

    await client.connect(transport as never);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(transport.sessionId).toBeUndefined();
      const legacyList = await client.listTools();
      const { tools } = legacyList;
      expect(tools).toHaveLength(192);
      expect(tools.map((tool) => tool.name)).toContain('messages_send');
      expect(legacyList.ttlMs).toBeUndefined();
      expect(legacyList.cacheScope).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('negotiates MCP 2026 and serves the same tools without session state', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    });
    const client = new Client(
      { name: 'http-modern-test', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    await client.connect(transport as never);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(transport.sessionId).toBeUndefined();
      fetchSpy.mockClear();
      const firstList = await client.listTools();
      const { tools, ttlMs, cacheScope } = firstList;
      expect(tools).toHaveLength(192);
      expect(tools.map((tool) => tool.name)).toContain('messages_send');
      expect(ttlMs).toBe(3_600_000);
      expect(cacheScope).toBe('private');
      const requestsAfterFirstList = fetchSpy.mock.calls.length;
      expect(requestsAfterFirstList).toBeGreaterThan(0);
      expect(await client.listTools()).toEqual(firstList);
      expect(fetchSpy).toHaveBeenCalledTimes(requestsAfterFirstList);
      const invalidCall = await client.callTool({ name: 'messages_send', arguments: {} });
      expect(invalidCall.isError).toBe(true);
    } finally {
      await client.close();
      fetchSpy.mockRestore();
    }
  });
});
