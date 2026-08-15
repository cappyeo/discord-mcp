import { execFile as nodeExecFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, copyFile, lstat, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeCodeApiKeyHelperCommand,
  buildClaudeCodeEnvironment,
  buildClaudeCodeMcpConfig,
  CLAUDE_CODE_TOKEN_PLACEHOLDER,
  createClaudeCodeAuthBroker,
  prepareClaudeCodePrivateState,
  quoteClaudeCodeShellArg,
  requestClaudeCodeApiKey,
  resolveClaudeCodeLauncher,
  resolveClaudeCodeShell,
  runBoundedClaudeCodeProcess,
  validateClaudeCodeMcpConfig,
  verifyClaudeCodeRuntimePaths,
} from './claude-code-driver.mjs';

const execFile = promisify(nodeExecFile);
const TARGET = Object.freeze({ guildId: '1537332825978568744', botId: '1533719084636700773' });
const API_KEY = 'sk-ant-test-key-that-must-never-be-written-to-disk';
const DRIVER_PATH = fileURLToPath(new URL('./claude-code-driver.mjs', import.meta.url));

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

describe('Claude Code ephemeral driver foundations', () => {
  it('builds and validates one exact target-bound MCP server in both modes', () => {
    for (const mode of ['preview', 'allow']) {
      const config = buildClaudeCodeMcpConfig({
        nodePath: process.execPath,
        cliPath: DRIVER_PATH,
        target: TARGET,
        stateDirectory: resolve(tmpdir(), 'claude state'),
        mode,
      });
      expect(Object.keys(config)).toEqual(['mcpServers']);
      expect(Object.keys(config.mcpServers)).toEqual(['discord-mcp']);
      expect(config.mcpServers['discord-mcp']).toMatchObject({
        command: process.execPath,
        args: [DRIVER_PATH, 'serve'],
      });
      expect(config.mcpServers['discord-mcp'].env).toMatchObject({
        DISCORD_TOKEN: CLAUDE_CODE_TOKEN_PLACEHOLDER,
        DISCORD_EXPECTED_BOT_ID: TARGET.botId,
        DISCORD_DEFAULT_GUILD_ID: TARGET.guildId,
        ALLOWED_GUILDS: TARGET.guildId,
        MCP_TOOL_SURFACE: 'progressive',
        MCP_AUDIT_ENABLED: 'true',
        MCP_DRY_RUN: mode === 'preview' ? 'true' : 'false',
        MCP_BLUEPRINT_STATE_DIR: resolve(tmpdir(), 'claude state'),
        MCP_WRITE_MODE: mode,
      });
      expect(JSON.stringify(config)).not.toContain(API_KEY);
      expect(() =>
        validateClaudeCodeMcpConfig(config, {
          nodePath: process.execPath,
          cliPath: DRIVER_PATH,
          target: TARGET,
          stateDirectory: resolve(tmpdir(), 'claude state'),
          mode,
        }),
      ).not.toThrow();
    }
  });

  it('creates a strict child environment without Anthropic or ambient secrets', () => {
    const environment = buildClaudeCodeEnvironment({
      sourceEnv: {
        PATH: 'safe-path',
        ANTHROPIC_API_KEY: API_KEY,
        AWS_SECRET_ACCESS_KEY: 'must-not-pass',
        DISCORD_TOKEN: 'ambient-token-must-not-win',
      },
      discordToken: 'Bot caller-owned-token',
      claudeConfigDir: resolve(tmpdir(), 'private claude state'),
    });
    expect(environment).toEqual({
      PATH: 'safe-path',
      DISCORD_TOKEN: 'Bot caller-owned-token',
      CLAUDE_CONFIG_DIR: resolve(tmpdir(), 'private claude state'),
    });
    expect(JSON.stringify(environment)).not.toContain(API_KEY);
  });

  it('serves the key only through the bounded authenticated broker', async () => {
    const broker = await createClaudeCodeAuthBroker({ apiKey: API_KEY, maxCalls: 2 });
    try {
      await expect(
        requestClaudeCodeApiKey({ endpoint: broker.endpoint, nonce: broker.nonce }),
      ).resolves.toBe(API_KEY);
      await expect(
        requestClaudeCodeApiKey({ endpoint: broker.endpoint, nonce: 'wrong-nonce' }),
      ).rejects.toThrow('AUTH_BROKER_DENIED');
      await expect(
        requestClaudeCodeApiKey({ endpoint: broker.endpoint, nonce: broker.nonce }),
      ).resolves.toBe(API_KEY);
      await expect(
        requestClaudeCodeApiKey({ endpoint: broker.endpoint, nonce: broker.nonce }),
      ).rejects.toThrow('AUTH_BROKER_DENIED');
      expect(broker.calls).toBe(2);
    } finally {
      await broker.cleanup();
    }
    if (process.platform !== 'win32')
      await expect(lstat(broker.endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back the broker when post-listen setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude broker rollback '));
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\discord-mcp-claude-rollback-${Date.now()}`
        : join(root, 'broker.sock');
    try {
      await expect(
        createClaudeCodeAuthBroker({
          apiKey: API_KEY,
          endpoint,
          afterListen: async () => {
            throw new Error('POST_LISTEN_SETUP_FAILED');
          },
        }),
      ).rejects.toThrow('POST_LISTEN_SETUP_FAILED');
      await expect(
        requestClaudeCodeApiKey({ endpoint, nonce: 'not-the-broker-nonce' }),
      ).rejects.toThrow('AUTH_BROKER_UNAVAILABLE');
      if (process.platform !== 'win32')
        await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('zeroes the key and attempts endpoint removal when broker close fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude broker close failure '));
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\discord-mcp-claude-close-${Date.now()}`
        : join(root, 'broker.sock');
    const server = net.createServer();
    const broker = await createClaudeCodeAuthBroker({ apiKey: API_KEY, endpoint, server });
    const close = server.close.bind(server);
    let failClose = true;
    server.close = (callback) => {
      if (failClose) {
        failClose = false;
        throw new Error('BROKER_CLOSE_FAILED');
      }
      return close(callback);
    };
    try {
      await expect(broker.cleanup()).rejects.toThrow('BROKER_CLOSE_FAILED');
      await expect(requestClaudeCodeApiKey({ endpoint, nonce: broker.nonce })).rejects.toThrow(
        process.platform === 'win32' ? 'AUTH_BROKER_DENIED' : 'AUTH_BROKER_UNAVAILABLE',
      );
    } finally {
      server.close = close;
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes the helper through the platform shell with spaces in its private path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude helper path '));
    const copiedDriver = join(root, 'driver with spaces.mjs');
    await copyFile(DRIVER_PATH, copiedDriver);
    const broker = await createClaudeCodeAuthBroker({ apiKey: API_KEY });
    try {
      const command = buildClaudeCodeApiKeyHelperCommand({
        nodePath: process.execPath,
        driverPath: copiedDriver,
        endpoint: broker.endpoint,
        nonce: broker.nonce,
      });
      const shell = await resolveClaudeCodeShell({ platform: process.platform });
      const shellArgs = process.platform === 'win32' ? ['-lc', command] : ['-c', command];
      const result = await execFile(shell.command, shellArgs, {
        timeout: 10_000,
        windowsHide: true,
      });
      expect(result.stdout).toBe(API_KEY);
      expect(command).not.toContain(API_KEY);
    } finally {
      await broker.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes only secret-free private settings/config and removes them on cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude private test '));
    const durableState = join(root, '..', 'claude durable state');
    const state = await prepareClaudeCodePrivateState({
      target: TARGET,
      cliPath: DRIVER_PATH,
      discordToken: 'Bot caller-owned-token',
      apiKey: API_KEY,
      baseDirectory: root,
      stateDirectory: durableState,
    });
    try {
      expect(state.path).toBe(state.root);
      const settingsText = await readFile(state.settingsPath, 'utf8');
      const configText = await readFile(state.mcpConfigPath, 'utf8');
      expect(settingsText).not.toContain(API_KEY);
      expect(settingsText).not.toContain('ANTHROPIC_API_KEY');
      expect(configText).not.toContain(API_KEY);
      expect(state.environment).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(settingsText).toContain('apiKeyHelper');
      if (process.platform !== 'win32') {
        await expect(lstat(state.root)).resolves.toMatchObject({ mode: expect.any(Number) });
        expect((await lstat(state.root)).mode & 0o777).toBe(0o700);
        expect((await lstat(state.settingsPath)).mode & 0o777).toBe(0o600);
        expect((await lstat(state.mcpConfigPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await state.cleanup();
    }
    expect(await missing(state.root)).toBe(true);
    await rm(durableState, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('removes private root and denies the broker when setup fails after broker creation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'claude setup cleanup base '));
    const stateDirectory = await mkdtemp(join(tmpdir(), 'claude setup cleanup state '));
    let broker;
    try {
      await expect(
        prepareClaudeCodePrivateState({
          target: TARGET,
          cliPath: DRIVER_PATH,
          apiKey: API_KEY,
          discordToken: undefined,
          baseDirectory: base,
          stateDirectory,
          createBroker: async (options) => {
            broker = await createClaudeCodeAuthBroker(options);
            return {
              ...broker,
              cleanup: async () => {
                await broker.cleanup();
                throw new Error('BROKER_CLEANUP_FAILED');
              },
            };
          },
        }),
      ).rejects.toThrow('DISCORD_TOKEN is required');
      expect(
        (await readdir(base)).filter((name) => name.startsWith('discord-mcp-claude-')),
      ).toEqual([]);
      await expect(
        requestClaudeCodeApiKey({ endpoint: broker.endpoint, nonce: broker.nonce }),
      ).rejects.toThrow(/AUTH_BROKER_(DENIED|UNAVAILABLE)/);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('rejects symlinked base and durable state directories', async () => {
    if (process.platform === 'win32') return;
    const base = await mkdtemp(join(tmpdir(), 'claude symlink base '));
    const baseTarget = await mkdtemp(join(tmpdir(), 'claude symlink base target '));
    const stateRoot = await mkdtemp(join(tmpdir(), 'claude symlink state '));
    const stateTarget = await mkdtemp(join(tmpdir(), 'claude symlink state target '));
    const baseLink = join(base, 'linked-base');
    const stateLink = join(stateRoot, 'linked-state');
    try {
      await symlink(baseTarget, baseLink, 'dir');
      await expect(
        prepareClaudeCodePrivateState({
          target: TARGET,
          cliPath: DRIVER_PATH,
          discordToken: 'Bot caller-owned-token',
          apiKey: API_KEY,
          baseDirectory: baseLink,
          stateDirectory: join(stateRoot, 'state'),
        }),
      ).rejects.toThrow(/symlink/);

      await symlink(stateTarget, stateLink, 'dir');
      await expect(
        prepareClaudeCodePrivateState({
          target: TARGET,
          cliPath: DRIVER_PATH,
          discordToken: 'Bot caller-owned-token',
          apiKey: API_KEY,
          baseDirectory: base,
          stateDirectory: stateLink,
        }),
      ).rejects.toThrow(/symlink/);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(baseTarget, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
      await rm(stateTarget, { recursive: true, force: true });
    }
  });

  it('resolves native launchers and rejects an unresolved Windows shim', async () => {
    const native = process.execPath;
    await expect(
      resolveClaudeCodeLauncher({ platform: process.platform, command: native }),
    ).resolves.toMatchObject({
      command: native,
      kind: 'native',
    });
    await expect(
      resolveClaudeCodeLauncher({
        platform: 'win32',
        run: async () => ({ stdout: 'C:\\not-real\\claude.cmd\n' }),
      }),
    ).rejects.toThrow('shim is unresolved');
  });

  it('verifies the canonical target of a POSIX symlink', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'claude symlink test '));
    const link = join(root, 'cli.js');
    try {
      await symlink(DRIVER_PATH, link);
      const result = await verifyClaudeCodeRuntimePaths({ cliPath: link });
      expect(result.cliPath).toBe(resolve(DRIVER_PATH));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('quotes shell arguments without exposing the private nonce in diagnostics', () => {
    const value = 'C:\\private path\\driver.mjs';
    expect(quoteClaudeCodeShellArg(value, process.platform)).toContain('private path');
    expect(() => quoteClaudeCodeShellArg('bad\npath', process.platform)).toThrow();
  });

  it('requires a process-tree close proof after timeout', async () => {
    const child = new EventEmitter();
    child.pid = 42;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const terminate = vi.fn(async ({ force }) => {
      if (force) child.emit('close', null, 'SIGKILL');
    });
    const result = await runBoundedClaudeCodeProcess({
      launcher: { command: 'claude', prefix_args: [] },
      args: ['--version'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 1,
      platform: 'win32',
      spawn: () => child,
      terminate,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGKILL' });
    expect(terminate).toHaveBeenNthCalledWith(1, { child, platform: 'win32', force: false });
    expect(terminate).toHaveBeenNthCalledWith(2, { child, platform: 'win32', force: true });
  });

  it('terminates and proves closure when an active invocation is aborted', async () => {
    const child = new EventEmitter();
    child.pid = 43;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const terminate = vi.fn(async () => child.emit('close', null, 'SIGTERM'));
    const controller = new AbortController();
    const pending = runBoundedClaudeCodeProcess({
      launcher: { command: 'claude', prefix_args: [] },
      args: ['--version'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      signal: controller.signal,
      platform: 'win32',
      spawn: () => child,
      terminate,
    });

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('fails closed when a started child errors and never provides a close proof', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 44;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const terminate = vi.fn(async () => {});
      const pending = runBoundedClaudeCodeProcess({
        launcher: { command: 'claude', prefix_args: [] },
        args: ['--version'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        platform: 'win32',
        spawn: () => child,
        terminate,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'CLAUDE_CODE_PROCESS_DID_NOT_CLOSE',
      });

      child.emit('error', new Error('child error'));
      await vi.advanceTimersByTimeAsync(4_000);

      await rejection;
      expect(terminate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn when cancellation is already requested', async () => {
    const spawn = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runBoundedClaudeCodeProcess({
        launcher: { command: 'claude', prefix_args: [] },
        args: ['--version'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        signal: controller.signal,
        spawn,
      }),
    ).resolves.toMatchObject({ aborted: true, spawnError: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns a bounded spawn failure without throwing or retaining a child', async () => {
    await expect(
      runBoundedClaudeCodeProcess({
        launcher: { command: 'claude', prefix_args: [] },
        args: ['--version'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        spawn: () => {
          throw new Error('spawn failed');
        },
      }),
    ).resolves.toMatchObject({ spawnError: true, exitCode: null, timedOut: false });
  });

  it('bounds captured stdout and marks truncation as a failed host result', async () => {
    const child = new EventEmitter();
    child.pid = 45;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const pending = runBoundedClaudeCodeProcess({
      launcher: { command: 'claude', prefix_args: [] },
      args: ['--version'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      spawn: () => child,
    });
    child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 10, 'x'));
    child.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({
      exitCode: 0,
      truncated: true,
      stdout: 'x'.repeat(8 * 1024 * 1024),
    });
  });

  it('rejects an invalid abort signal before spawning', async () => {
    const spawn = vi.fn();
    await expect(
      runBoundedClaudeCodeProcess({
        launcher: { command: 'claude', prefix_args: [] },
        args: ['--version'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        signal: { aborted: false },
        spawn,
      }),
    ).rejects.toThrow('signal must be an AbortSignal');
    expect(spawn).not.toHaveBeenCalled();
  });
});
