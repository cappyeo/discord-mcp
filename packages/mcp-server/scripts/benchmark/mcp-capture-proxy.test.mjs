import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMcpCaptureChildEnvironment,
  consumeCapturedMcpCall,
  MCP_CAPTURE_SCHEMA,
  parseMcpCaptureProxyArgs,
  sanitizeCapturedMcpResponse,
} from './mcp-capture-proxy.mjs';

const PROXY_PATH = resolve(import.meta.dirname, 'mcp-capture-proxy.mjs');
const SERVER_PATH = resolve(import.meta.dirname, 'fixtures/mcp-server.mjs');
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateCapture() {
  const root = await mkdtemp(join(tmpdir(), 'discord-mcp-capture-proxy-'));
  roots.push(root);
  const capturePath = join(root, 'capture.jsonl');
  await writeFile(capturePath, '', { mode: 0o600 });
  return { root, capturePath };
}

describe('private MCP capture proxy', () => {
  it('captures full structuredContent before exposing only text to the host', async () => {
    const { capturePath } = await privateCapture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [PROXY_PATH, '--capture', capturePath, '--', process.execPath, SERVER_PATH],
      cwd: resolve(import.meta.dirname, '../..'),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'capture-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'guild_blueprint_plan', arguments: {} });
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        { type: 'text', text: 'guild_blueprint_plan fixture response' },
      ]);
    } finally {
      await client.close();
    }

    const state = { capturePath, captureCursor: 0 };
    const capture = consumeCapturedMcpCall(state, 'guild_blueprint_plan');
    expect(capture).toMatchObject({
      schema_version: MCP_CAPTURE_SCHEMA,
      tool_name: 'guild_blueprint_plan',
      arguments: {},
      result: { structuredContent: { status: 'fixture', tool: 'guild_blueprint_plan' } },
    });
    expect(state.captureCursor).toBe(1);
    expect(() => consumeCapturedMcpCall(state, 'guild_blueprint_plan')).toThrow(
      'CAPTURE_COUNT_INVALID',
    );
  });

  it('sanitizes both structured content spellings without changing other JSON-RPC fields', () => {
    expect(
      sanitizeCapturedMcpResponse({
        jsonrpc: '2.0',
        id: 7,
        result: {
          content: [{ type: 'text', text: 'receipt' }],
          structuredContent: { plan_token: 'private' },
          structured_content: { plan_token: 'private' },
          isError: false,
        },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'receipt' }], isError: false },
    });
  });

  it('rejects malformed launch arguments and raw plan-token replay', async () => {
    expect(() =>
      parseMcpCaptureProxyArgs(['--capture', 'relative', '--', process.execPath]),
    ).toThrow('capture path must be absolute');
    const { capturePath } = await privateCapture();
    await writeFile(
      capturePath,
      `${JSON.stringify({
        schema_version: MCP_CAPTURE_SCHEMA,
        capture_id: 'capture',
        ordinal: 1,
        tool_name: 'guild_blueprint_apply',
        arguments: { plan_token: 'legacy-secret' },
        result: { structuredContent: { status: 'complete' } },
      })}\n`,
    );
    expect(() =>
      consumeCapturedMcpCall({ capturePath, captureCursor: 0 }, 'guild_blueprint_apply'),
    ).toThrow('RAW_PLAN_TOKEN');
  });

  it('keeps host authentication out of the captured MCP child environment', () => {
    expect(
      parseMcpCaptureProxyArgs([
        '--capture',
        resolve('capture.jsonl'),
        '--strip-env',
        'GEMINI_API_KEY',
        '--',
        process.execPath,
      ]),
    ).toMatchObject({ stripEnv: ['GEMINI_API_KEY'], command: resolve(process.execPath) });
    const parent = {
      PATH: 'safe-path',
      GEMINI_API_KEY: 'host-only-model-key',
      DISCORD_TOKEN: 'caller-owned-bot-token',
    };
    expect(buildMcpCaptureChildEnvironment(parent, ['GEMINI_API_KEY'])).toEqual({
      PATH: 'safe-path',
      DISCORD_TOKEN: 'caller-owned-bot-token',
    });
    expect(parent).toHaveProperty('GEMINI_API_KEY');
    expect(() =>
      parseMcpCaptureProxyArgs([
        '--capture',
        resolve('capture.jsonl'),
        '--strip-env',
        'gemini_api_key',
        '--',
        process.execPath,
      ]),
    ).toThrow('environment scrub key is invalid');
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked capture file', async () => {
    const { root, capturePath } = await privateCapture();
    const target = join(root, 'target.jsonl');
    await writeFile(target, '');
    await rm(capturePath);
    await symlink(target, capturePath, 'file');
    expect(() =>
      consumeCapturedMcpCall({ capturePath, captureCursor: 0 }, 'guild_blueprint_plan'),
    ).toThrow('CAPTURE_FILE_INVALID');
  });
});
