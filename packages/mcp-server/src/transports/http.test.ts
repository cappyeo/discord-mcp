import { once } from 'node:events';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHttp } from './http.js';

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;
const ACCESS_TOKEN = 'test-access-token-with-at-least-32-characters';
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

async function postChunked(
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; retryAfter: string | undefined }> {
  const url = endpoint();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            retryAfter: response.headers['retry-after'],
          }),
        );
      },
    );
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}

beforeEach(() => {
  process.env.DISCORD_TOKEN = VALID_TOKEN;
  process.env.DISCORD_MCP_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.LOG_LEVEL = 'fatal';
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.DISCORD_EXPECTED_BOT_ID;
  delete process.env.MCP_HTTP_MAX_BODY_BYTES;
  delete process.env.MCP_HTTP_MAX_IN_FLIGHT;
  delete process.env.MCP_WRITE_MODE;
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

  it('rejects wrong bearer credentials and accepts the case-insensitive auth scheme', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect((await postChunked(body, { Authorization: 'Bearer wrong-token' })).status).toBe(401);
    expect((await postChunked(body, { Authorization: `bearer ${ACCESS_TOKEN}` })).status).not.toBe(
      401,
    );
  });

  it('rejects untrusted Host and Origin headers on the default loopback listener', async () => {
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect((await postChunked(body, { Host: 'attacker.example' })).status).toBe(403);
    expect((await postChunked(body, { Origin: 'https://attacker.example' })).status).toBe(403);
  });

  it('rejects oversized declared and chunked bodies before the SDK buffers them', async () => {
    process.env.MCP_HTTP_MAX_BODY_BYTES = '1024';
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
      padding: 'x'.repeat(2048),
    });

    const declaredResponse = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    });
    const chunkedResponse = await postChunked(body);

    expect(declaredResponse.status).toBe(413);
    expect(chunkedResponse.status).toBe(413);
  });

  it('fast-rejects authenticated requests when the HTTP in-flight limit is full', async () => {
    process.env.MCP_HTTP_MAX_IN_FLIGHT = '1';
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const address = server.address() as AddressInfo;
    const socket = createConnection(address.port, '127.0.0.1');
    await once(socket, 'connect');
    const requestObserved = once(server, 'request');
    socket.write(
      [
        'POST /mcp HTTP/1.1',
        `Host: 127.0.0.1:${address.port}`,
        `Authorization: Bearer ${ACCESS_TOKEN}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
      ].join('\r\n'),
    );
    await requestObserved;

    try {
      const response = await postChunked(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      );
      expect(response.status).toBe(503);
      expect(response.retryAfter).toBe('1');
    } finally {
      socket.destroy();
    }
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
      expect(tools).toHaveLength(205);
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
      expect(tools).toHaveLength(205);
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

  it('applies the shared write-preview policy to HTTP tool calls', async () => {
    process.env.MCP_WRITE_MODE = 'preview';
    server = await startHttp({ port: 0, registerSignalHandlers: false });
    const transport = new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
    });
    const client = new Client({ name: 'http-policy-test', version: '0.0.0' });

    await client.connect(transport as never);
    try {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: '111122223333444455', content: 'must not reach Discord' },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'WRITE_PREVIEW' });
    } finally {
      await client.close();
    }
  });
});
