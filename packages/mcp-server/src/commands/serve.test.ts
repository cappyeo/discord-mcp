import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProfile } from '../lib/profiles.js';

// Mock startStdio BEFORE importing serveAction so the import sees the mock.
vi.mock('../transports/stdio.js', () => ({
  startStdio: vi.fn(async () => {
    // No-op: a real startStdio would block on the MCP transport.
  }),
}));
vi.mock('../transports/http.js', () => ({
  startHttp: vi.fn(async () => {
    // No-op: a real startHttp would keep the HTTP server listening.
  }),
}));

const { serveAction } = await import('./serve.js');
const { startHttp } = await import('../transports/http.js');
const { startStdio } = await import('../transports/stdio.js');

const originalGateway = process.env.GATEWAY;
const originalToken = process.env.DISCORD_TOKEN;
const originalExpectedBotId = process.env.DISCORD_EXPECTED_BOT_ID;
const originalAllowedGuilds = process.env.ALLOWED_GUILDS;
const originalToolSurface = process.env.MCP_TOOL_SURFACE;

beforeEach(() => {
  delete process.env.GATEWAY;
  vi.mocked(startHttp).mockClear();
  vi.mocked(startStdio).mockClear();
});

afterEach(() => {
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('GATEWAY', originalGateway);
  restore('DISCORD_TOKEN', originalToken);
  restore('DISCORD_EXPECTED_BOT_ID', originalExpectedBotId);
  restore('ALLOWED_GUILDS', originalAllowedGuilds);
  restore('MCP_TOOL_SURFACE', originalToolSurface);
});

describe('serveAction', () => {
  it('calls startStdio with no gateway flag', async () => {
    await serveAction({});
    expect(startStdio).toHaveBeenCalledTimes(1);
    expect(process.env.GATEWAY).toBeUndefined();
  });

  it('sets GATEWAY=1 when gateway: true', async () => {
    await serveAction({ gateway: true });
    expect(process.env.GATEWAY).toBe('1');
    expect(startStdio).toHaveBeenCalledTimes(1);
  });

  it('does not set GATEWAY when gateway: false', async () => {
    await serveAction({ gateway: false });
    expect(process.env.GATEWAY).toBeUndefined();
    expect(startStdio).toHaveBeenCalledTimes(1);
  });

  it('starts Streamable HTTP with the requested address', async () => {
    await serveAction({ http: true, host: '0.0.0.0', port: 8080 });
    expect(startStdio).not.toHaveBeenCalled();
    expect(startHttp).toHaveBeenCalledWith({ host: '0.0.0.0', port: 8080 });
  });

  it('activates a caller-owned bot profile before starting stdio', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-serve-profile-'));
    try {
      process.env.DISCORD_TOKEN = `Bot ${'x'.repeat(60)}`;
      saveProfile(
        {
          version: 1,
          name: 'devbot',
          bot: { id: '987654321098765432', username: 'DevBot' },
          credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
          allowedGuilds: ['111122223333444455'],
          client: 'codex',
          toolSurface: 'progressive',
          gateway: false,
        },
        { directory },
      );

      await serveAction({ profile: 'devbot', profileDirectory: directory });

      expect(startStdio).toHaveBeenCalledTimes(1);
      expect(process.env.DISCORD_EXPECTED_BOT_ID).toBe('987654321098765432');
      expect(process.env.ALLOWED_GUILDS).toBe('111122223333444455');
      expect(process.env.MCP_TOOL_SURFACE).toBe('progressive');
      expect(process.env.DISCORD_TOKEN).toBe(`Bot ${'x'.repeat(60)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects Gateway mode with HTTP transport', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(serveAction({ http: true, gateway: true })).rejects.toThrow(
        'process.exit called',
      );
      expect(startHttp).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Gateway subscriptions are available only with the stdio transport.',
        ),
      );
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('calls process.exit(1) on startStdio failure', async () => {
    vi.mocked(startStdio).mockRejectedValueOnce(new Error('boom'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      // Throw to abort serveAction so the test can assert without actually exiting.
      throw new Error('process.exit called');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(serveAction({})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? '');
      expect(written).toContain('discord-mcp failed to start: boom');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
