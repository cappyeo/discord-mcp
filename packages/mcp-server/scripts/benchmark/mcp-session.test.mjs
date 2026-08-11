import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { openMcpBenchmarkSession } from './mcp-session.mjs';

const SERVER_PATH = resolve(import.meta.dirname, 'fixtures/mcp-server.mjs');
const FAILING_SERVER_PATH = resolve(import.meta.dirname, 'fixtures/failing-server.mjs');

describe('openMcpBenchmarkSession', () => {
  it('boots a real stdio child process and exposes the North Star tools', async () => {
    const session = await openMcpBenchmarkSession({
      cliPath: SERVER_PATH,
      cwd: resolve(import.meta.dirname, '../..'),
      env: {},
    });

    try {
      expect(session.pid).toBeTypeOf('number');
      expect(session.toolNames).toEqual(
        expect.arrayContaining([
          'guild_blueprint_plan',
          'guild_blueprint_apply',
          'guild_blueprint_evidence',
        ]),
      );
      await expect(session.callTool('guild_blueprint_plan', {})).resolves.toEqual({
        status: 'fixture',
        tool: 'guild_blueprint_plan',
      });
    } finally {
      await session.close();
    }
  });

  it('creates a fresh process after an explicit restart boundary', async () => {
    const options = {
      cliPath: SERVER_PATH,
      cwd: resolve(import.meta.dirname, '../..'),
      env: {},
    };
    const first = await openMcpBenchmarkSession(options);
    const firstPid = first.pid;
    await first.close();

    const second = await openMcpBenchmarkSession(options);
    try {
      expect(second.pid).not.toBe(firstPid);
    } finally {
      await second.close();
    }
  });

  it('fails closed when a required public tool is absent', async () => {
    await expect(
      openMcpBenchmarkSession({
        cliPath: SERVER_PATH,
        cwd: resolve(import.meta.dirname, '../..'),
        env: {},
        requiredTools: ['guild_blueprint_plan', 'missing_benchmark_tool'],
      }),
    ).rejects.toThrow('missing required MCP tools: missing_benchmark_tool');
  });

  it('drains child stderr for diagnostics without exposing credentials', async () => {
    const secret = 'child-process-secret-value';
    await expect(
      openMcpBenchmarkSession({
        cliPath: FAILING_SERVER_PATH,
        cwd: resolve(import.meta.dirname, '../..'),
        env: { DISCORD_TOKEN: secret },
      }),
    ).rejects.toSatisfy((error) => {
      expect(String(error)).toContain('fixture failure');
      expect(String(error)).toContain('[REDACTED]');
      expect(String(error)).not.toContain(secret);
      return true;
    });
  });

  it('rejects ambient process credentials instead of forwarding them to the MCP child', async () => {
    await expect(
      openMcpBenchmarkSession({
        cliPath: SERVER_PATH,
        cwd: resolve(import.meta.dirname, '../..'),
        env: { AWS_SECRET_ACCESS_KEY: 'must-not-be-forwarded' },
      }),
    ).rejects.toThrow('unsupported MCP child environment keys');
  });

  it('preserves the structured MCP tool error code on the thrown session error', async () => {
    const session = await openMcpBenchmarkSession({
      cliPath: SERVER_PATH,
      cwd: resolve(import.meta.dirname, '../..'),
      env: {},
    });
    const callTool = vi
      .spyOn(Client.prototype, 'callTool')
      .mockResolvedValue({ isError: true, structuredContent: { code: 'GUILD_NOT_ALLOWED' } });

    try {
      await expect(session.callTool('guild_blueprint_plan', {})).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe('GUILD_NOT_ALLOWED');
        expect(error.source).toBe('mcp_tool_result');
        expect(error.message).toBe('guild_blueprint_plan failed (GUILD_NOT_ALLOWED)');
        return true;
      });
    } finally {
      callTool.mockRestore();
      await session.close();
    }
  });

  it('does not mark a transport error as an MCP tool-result rejection', async () => {
    const session = await openMcpBenchmarkSession({
      cliPath: SERVER_PATH,
      cwd: resolve(import.meta.dirname, '../..'),
      env: {},
    });
    const transportError = Object.assign(new Error('transport failed'), {
      code: 'GUILD_NOT_ALLOWED',
    });
    const callTool = vi.spyOn(Client.prototype, 'callTool').mockRejectedValue(transportError);

    try {
      await expect(session.callTool('guild_blueprint_plan', {})).rejects.toSatisfy((error) => {
        expect(error).toBe(transportError);
        expect(error.source).toBeUndefined();
        return true;
      });
    } finally {
      callTool.mockRestore();
      await session.close();
    }
  });

  it('preserves bounded retry metadata from a structured MCP tool error', async () => {
    const session = await openMcpBenchmarkSession({
      cliPath: SERVER_PATH,
      cwd: resolve(import.meta.dirname, '../..'),
      env: {},
    });
    const callTool = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({
      isError: true,
      structuredContent: {
        code: 'UPSTREAM_TIMEOUT',
        retriable: true,
        retry_after_ms: 2_500,
      },
    });

    try {
      await expect(session.callTool('guild_blueprint_plan', {})).rejects.toSatisfy((error) => {
        expect(error.code).toBe('UPSTREAM_TIMEOUT');
        expect(error.source).toBe('mcp_tool_result');
        expect(error.retriable).toBe(true);
        expect(error.retryAfterMs).toBe(2_500);
        return true;
      });
    } finally {
      callTool.mockRestore();
      await session.close();
    }
  });
});
