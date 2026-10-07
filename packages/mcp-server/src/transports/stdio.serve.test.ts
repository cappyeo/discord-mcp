import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const probe = resolve(process.cwd(), 'test-fixtures/stdio-serve-probe.mjs');
const catalogProbe = resolve(process.cwd(), 'test-fixtures/catalog-stdio-probe.mjs');

async function listWith(versionNegotiation?: { mode: 'auto' }): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [probe],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'stdio-serve-test', version: '1.0.0' },
    versionNegotiation === undefined ? undefined : { versionNegotiation },
  );
  await client.connect(transport);
  await expect(client.listTools()).resolves.toMatchObject({
    tools: [expect.objectContaining({ name: 'probe' })],
  });
  return { client, transport };
}

describe('serveStdio protocol bridge', () => {
  it('serves both legacy and modern stdio clients from one child process entrypoint', async () => {
    const legacy = await listWith();
    expect(legacy.client.getProtocolEra()).toBe('legacy');
    await legacy.client.close();

    const modern = await listWith({ mode: 'auto' });
    expect(modern.client.getProtocolEra()).toBe('modern');
    expect(modern.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await modern.client.close();
  });

  it('creates a fresh server after a modern discover probe falls back to legacy initialize', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [probe],
      stderr: 'pipe',
    });
    const messages: unknown[] = [];
    let resolveMessage: (() => void) | undefined;
    transport.onmessage = (message) => {
      messages.push(message);
      resolveMessage?.();
    };
    await transport.start();
    const nextMessage = async () => {
      while (messages.length === 0)
        await new Promise<void>((resolve) => (resolveMessage = resolve));
      resolveMessage = undefined;
      return messages.shift();
    };
    try {
      await transport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'fallback-probe', version: '1.0.0' },
          },
        },
      });
      const discover = (await nextMessage()) as {
        result?: { _meta?: { 'io.modelcontextprotocol/serverInfo'?: { version?: string } } };
      };
      expect(discover.result?._meta?.['io.modelcontextprotocol/serverInfo']?.version).toBe(
        'factory-1',
      );
      await transport.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-fallback', version: '1.0.0' },
        },
      });
      const initialize = (await nextMessage()) as {
        result?: { serverInfo?: { version?: string } };
      };
      expect(initialize.result?.serverInfo?.version).toBe('factory-2');
    } finally {
      await transport.close();
    }
  });

  it('serves the credentialless catalog to a modern stdio client', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [catalogProbe],
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'catalog-stdio-serve-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'guild_blueprint_plan' }),
          expect.objectContaining({ name: 'messages_send' }),
        ]),
      });
      expect((await client.listTools()).tools).toHaveLength(222);
    } finally {
      await client.close();
    }
  });

  it('exits when the real stdio input reaches EOF', async () => {
    const child = spawn(process.execPath, [probe], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stdin.end();
    const [code, signal] = await once(child, 'exit');
    expect(code).toBe(0);
    expect(signal).toBeNull();
  });
});
