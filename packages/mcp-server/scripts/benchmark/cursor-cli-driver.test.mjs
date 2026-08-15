import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCursorCliEnvironment,
  buildCursorCliMcpConfig,
  buildCursorCliPermissions,
  prepareCursorCliPrivateState,
  resolveCursorCliLauncher,
  validateCursorCliMcpConfig,
} from './cursor-cli-driver.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const TARGET = { guildId: GUILD_ID, botId: BOT_ID };
const DISCORD_TOKEN = 'fixture.discord.token';
const CURSOR_API_KEY = 'fixture-cursor-key';
const roots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cursor-cli-driver-test-'));
  roots.push(root);
  const state = join(root, 'state');
  await mkdir(state);
  const cli = join(root, 'cli.mjs');
  const proxy = join(root, 'proxy.mjs');
  const posixVersionDirectory = join(
    root,
    '.local',
    'share',
    'cursor-agent',
    'versions',
    'fixture',
  );
  const windowsInstallDirectory = join(root, 'cursor-agent');
  const rogueDirectory = join(root, 'rogue');
  await Promise.all([
    mkdir(posixVersionDirectory, { recursive: true }),
    mkdir(windowsInstallDirectory, { recursive: true }),
    mkdir(rogueDirectory, { recursive: true }),
  ]);
  const posixLauncher = join(posixVersionDirectory, 'cursor-agent');
  const windowsLauncher = join(windowsInstallDirectory, 'agent.exe');
  const windowsLegacyLauncher = join(windowsInstallDirectory, 'cursor-agent.exe');
  const windowsShim = join(windowsInstallDirectory, 'agent.cmd');
  const roguePosixLauncher = join(rogueDirectory, 'cursor-agent');
  const rogueWindowsLauncher = join(rogueDirectory, 'agent.exe');
  await Promise.all([
    writeFile(cli, '', 'utf8'),
    writeFile(proxy, '', 'utf8'),
    writeFile(posixLauncher, '#!/bin/sh\n', 'utf8'),
    writeFile(windowsLauncher, '', 'utf8'),
    writeFile(windowsLegacyLauncher, '', 'utf8'),
    writeFile(windowsShim, '', 'utf8'),
    writeFile(roguePosixLauncher, '#!/bin/sh\n', 'utf8'),
    writeFile(rogueWindowsLauncher, '', 'utf8'),
  ]);
  await Promise.all([chmod(posixLauncher, 0o700), chmod(roguePosixLauncher, 0o700)]);
  return {
    root,
    state,
    cli,
    proxy,
    posixLauncher,
    windowsLauncher,
    windowsLegacyLauncher,
    windowsShim,
    roguePosixLauncher,
    rogueWindowsLauncher,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Cursor Agent CLI activation driver', () => {
  it('builds exact deny-by-default permissions and target-bound secret-free MCP config', async () => {
    const item = await fixture();
    const capture = join(item.root, 'capture.jsonl');
    await writeFile(capture, '', 'utf8');
    const config = buildCursorCliMcpConfig({
      nodePath: process.execPath,
      cliPath: item.cli,
      proxyPath: item.proxy,
      capturePath: capture,
      target: TARGET,
      stateDirectory: item.state,
      mode: 'allow',
    });
    expect(config.mcpServers['discord-mcp'].env).toMatchObject({
      DISCORD_EXPECTED_BOT_ID: BOT_ID,
      DISCORD_DEFAULT_GUILD_ID: GUILD_ID,
      ALLOWED_GUILDS: GUILD_ID,
      MCP_WRITE_MODE: 'allow',
      MCP_DRY_RUN: 'false',
    });
    expect(JSON.stringify(config)).not.toContain(DISCORD_TOKEN);
    expect(JSON.stringify(config)).not.toContain(CURSOR_API_KEY);
    expect(
      validateCursorCliMcpConfig(config, {
        nodePath: process.execPath,
        cliPath: item.cli,
        proxyPath: item.proxy,
        capturePath: capture,
        target: TARGET,
        stateDirectory: item.state,
        mode: 'allow',
        cursorApiKey: CURSOR_API_KEY,
      }),
    ).toBe(true);
    expect(buildCursorCliPermissions()).toEqual({
      permissions: {
        allow: [
          'Mcp(discord-mcp:build_discord_server)',
          'Mcp(discord-mcp:guild_blueprint_apply)',
          'Mcp(discord-mcp:guild_blueprint_evidence)',
        ],
        deny: ['Shell(*)', 'Read(**)', 'Write(**)'],
      },
    });
  });

  it('keeps both credentials in process memory while isolating Cursor home', async () => {
    const item = await fixture();
    const environment = buildCursorCliEnvironment({
      sourceEnv: { PATH: '/bin', CURSOR_API_KEY, UNRELATED_SECRET: 'drop-me' },
      discordToken: DISCORD_TOKEN,
      privateHome: item.root,
    });
    expect(environment).toMatchObject({
      PATH: '/bin',
      CURSOR_API_KEY,
      DISCORD_TOKEN,
      HOME: item.root,
      USERPROFILE: item.root,
    });
    expect(environment).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('prepares and removes a private Cursor workspace without persisting credential values', async () => {
    const item = await fixture();
    const privateState = await prepareCursorCliPrivateState({
      target: TARGET,
      cliPath: item.cli,
      nodePath: process.execPath,
      proxyPath: item.proxy,
      discordToken: DISCORD_TOKEN,
      stateDirectory: item.state,
      mode: 'allow',
      sourceEnv: { PATH: '/bin', CURSOR_API_KEY },
      baseDirectory: item.root,
      platform: process.platform,
    });
    const saved = `${await readFile(privateState.mcpConfigPath, 'utf8')}\n${await readFile(
      privateState.settingsPath,
      'utf8',
    )}`;
    expect(saved).not.toContain(DISCORD_TOKEN);
    expect(saved).not.toContain(CURSOR_API_KEY);
    expect(privateState.environment.CURSOR_API_KEY).toBe(CURSOR_API_KEY);
    expect(privateState.environment.DISCORD_TOKEN).toBe(DISCORD_TOKEN);
    await privateState.cleanup();
    await expect(readFile(privateState.mcpConfigPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'resolves the primary agent command to the official POSIX installer target',
    async () => {
      const item = await fixture();
      const run = vi.fn(async () => ({ stdout: `${item.posixLauncher}\n` }));
      await expect(
        resolveCursorCliLauncher({
          platform: 'linux',
          environment: { HOME: item.root },
          run,
        }),
      ).resolves.toEqual({ command: item.posixLauncher, prefix_args: [], kind: 'native' });
      expect(run).toHaveBeenCalledWith('which', ['agent'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      await expect(
        resolveCursorCliLauncher({
          platform: 'linux',
          command: 'cursor-agent',
          environment: { HOME: item.root },
          run,
        }),
      ).resolves.toEqual({ command: item.posixLauncher, prefix_args: [], kind: 'native' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a same-named POSIX launcher outside the official install root',
    async () => {
      const item = await fixture();
      await expect(
        resolveCursorCliLauncher({
          platform: 'linux',
          environment: { HOME: item.root },
          run: async () => ({ stdout: `${item.roguePosixLauncher}\n` }),
        }),
      ).rejects.toThrow('official Cursor Agent CLI launcher is unavailable');
    },
  );

  it('resolves the official native Windows launcher without a shell fallback', async () => {
    const item = await fixture();
    const run = vi.fn(async () => ({ stdout: `${item.rogueWindowsLauncher}\n` }));
    await expect(
      resolveCursorCliLauncher({
        platform: 'win32',
        environment: { LOCALAPPDATA: item.root },
        run,
      }),
    ).resolves.toEqual({ command: item.windowsLauncher, prefix_args: [], kind: 'native' });
    expect(run).not.toHaveBeenCalled();
    await expect(
      resolveCursorCliLauncher({
        platform: 'win32',
        command: item.windowsLegacyLauncher,
        environment: { LOCALAPPDATA: item.root },
        run,
      }),
    ).resolves.toEqual({
      command: item.windowsLegacyLauncher,
      prefix_args: [],
      kind: 'native',
    });
  });

  it('rejects native Windows shims and launchers outside the official install root', async () => {
    const item = await fixture();
    await expect(
      resolveCursorCliLauncher({
        platform: 'win32',
        command: 'another-agent',
        environment: { LOCALAPPDATA: item.root },
      }),
    ).rejects.toThrow('must use the official agent command');
    for (const command of [item.windowsShim, item.rogueWindowsLauncher]) {
      await expect(
        resolveCursorCliLauncher({
          platform: 'win32',
          command,
          environment: { LOCALAPPDATA: item.root },
        }),
      ).rejects.toThrow('official Cursor Agent CLI launcher is unavailable');
    }
  });

  it('rejects config drift and a persisted Cursor credential value', async () => {
    const item = await fixture();
    const capture = join(item.root, 'capture.jsonl');
    await writeFile(capture, '', 'utf8');
    const options = {
      nodePath: process.execPath,
      cliPath: item.cli,
      proxyPath: item.proxy,
      capturePath: capture,
      target: TARGET,
      stateDirectory: item.state,
      mode: 'allow',
      cursorApiKey: CURSOR_API_KEY,
    };
    const config = buildCursorCliMcpConfig(options);
    config.mcpServers['discord-mcp'].env.CURSOR_SECRET = CURSOR_API_KEY;
    expect(() => validateCursorCliMcpConfig(config, options)).toThrow('target-bound contract');
  });
});
