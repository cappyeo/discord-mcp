/**
 * Production boot-path coverage for `startStdio()`.
 *
 * Every other suite stubs this function out, so the real chain — loadConfig →
 * buildPolicy → wrapRestWithResilience → buildServer → gateway → connect —
 * had zero assertions on it. Here we run it end to end against an in-memory
 * MCP transport and a real `Client`, so dropping `server.connect(transport)`
 * or reordering the `wrapRestWithResilience` arguments fails the suite.
 *
 * `@discord-mcp/core` is only PARTIALLY mocked: everything keeps its real
 * implementation except `createLogger` (replaced by a capturing stub so the
 * ready/warn records are assertable — pino writes straight to fd 2 and would
 * bypass a process.stderr spy) and `createGatewayClient` (which would
 * otherwise open a real Discord websocket).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

const { makeLoggerStub } = vi.hoisted(() => ({
  makeLoggerStub: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@discord-mcp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discord-mcp/core')>();
  return {
    ...actual,
    createLogger: vi.fn(makeLoggerStub),
    createGatewayClient: vi.fn(),
    wrapRestWithResilience: vi.fn(actual.wrapRestWithResilience),
  };
});

import { createGatewayClient, createLogger, wrapRestWithResilience } from '@discord-mcp/core';
import { startStdio } from './stdio.js';

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;
const HALF_OPEN_MS = 12_345;

const savedEnv = { ...process.env };

type LoggerStub = ReturnType<typeof makeLoggerStub>;

/** The stub returned by the most recent `createLogger()` call. */
function lastLogger(): LoggerStub {
  const results = vi.mocked(createLogger).mock.results;
  return results[results.length - 1]?.value as unknown as LoggerStub;
}

/** Payload of the `discord-mcp ready (stdio)` info record. */
function readyRecord(): Record<string, unknown> {
  const call = lastLogger().info.mock.calls.find((c) => c[1] === 'discord-mcp ready (stdio)');
  expect(call, 'expected a ready log record').toBeDefined();
  return (call as unknown[])[0] as Record<string, unknown>;
}

/** Boots the real server over an in-memory pair and returns a connected client. */
async function boot(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startStdio({ transport: serverTransport, registerSignalHandlers: false });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function fakeGateway(start: Mock): void {
  vi.mocked(createGatewayClient).mockReturnValue({
    start,
    stop: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof createGatewayClient>);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_TOKEN = VALID_TOKEN;
  process.env.MCP_CIRCUIT_HALF_OPEN_AFTER_MS = String(HALF_OPEN_MS);
  process.env.MCP_AUDIT_ENABLED = 'false';
  delete process.env.GATEWAY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('startStdio', () => {
  it('boots the whole chain and serves the registered tools over the transport', async () => {
    const client = await boot();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(readyRecord()).toMatchObject({ tools: tools.length, gateway: false });
    } finally {
      await client.close();
    }
  });

  it('forwards circuitHalfOpenAfterMs to wrapRestWithResilience', async () => {
    const client = await boot();
    try {
      expect(wrapRestWithResilience).toHaveBeenCalledTimes(1);
      // Third arg is optional, so tsc cannot catch its loss — assert it here.
      expect(vi.mocked(wrapRestWithResilience).mock.calls[0]?.[2]).toEqual({
        circuitHalfOpenAfterMs: HALF_OPEN_MS,
      });
    } finally {
      await client.close();
    }
  });

  it('reports gateway: true when the gateway starts', async () => {
    process.env.GATEWAY = '1';
    const start = vi.fn(async () => {});
    fakeGateway(start);

    const client = await boot();
    try {
      expect(start).toHaveBeenCalledTimes(1);
      expect(readyRecord()).toMatchObject({ gateway: true });
      expect(lastLogger().warn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('warns and continues in REST-only mode when the gateway fails to start', async () => {
    process.env.GATEWAY = '1';
    fakeGateway(
      vi.fn(async () => {
        throw new Error('gateway boom');
      }),
    );

    const client = await boot();
    try {
      expect(lastLogger().warn).toHaveBeenCalledWith(
        { err: 'gateway boom' },
        'Discord Gateway failed to start — continuing in REST-only mode',
      );
      expect(readyRecord()).toMatchObject({ gateway: false });
      // REST-only continuation: the server is still fully operational.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
