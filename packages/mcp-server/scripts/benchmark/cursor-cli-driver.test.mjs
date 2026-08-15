import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
  const launcher = join(root, 'cursor-agent');
  await Promise.all([
    writeFile(cli, '', 'utf8'),
    writeFile(proxy, '', 'utf8'),
    writeFile(launcher, '#!/bin/sh\n', 'utf8'),
  ]);
  await chmod(launcher, 0o700);
  return { root, state, cli, proxy, launcher };
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
    'resolves only the unambiguous cursor-agent alias on POSIX',
    async () => {
      const item = await fixture();
      await expect(
        resolveCursorCliLauncher({
          platform: 'linux',
          run: async () => ({ stdout: `${item.launcher}\n` }),
        }),
      ).resolves.toMatchObject({ command: item.launcher, kind: 'native' });
      await expect(
        resolveCursorCliLauncher({ platform: 'linux', command: 'agent', run: async () => ({}) }),
      ).rejects.toThrow('unambiguous cursor-agent');
    },
  );

  it('rejects native Windows before discovery', async () => {
    const item = await fixture();
    void item;
    await expect(resolveCursorCliLauncher({ platform: 'win32' })).rejects.toThrow('requires WSL');
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
