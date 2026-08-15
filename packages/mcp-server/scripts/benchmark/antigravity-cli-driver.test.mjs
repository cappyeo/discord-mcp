import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_CLI_TOOLS,
  buildAntigravityEnvironment,
  buildAntigravityMcpConfig,
  buildAntigravityPermissions,
  prepareAntigravityPrivateState,
  resolveAntigravityLauncher,
  validateAntigravityMcpConfig,
} from './antigravity-cli-driver.mjs';

const TARGET = { guildId: '999000999000999001', botId: '999000999000999000' };
const TOKEN = `Bot ${'s'.repeat(60)}`;
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'discord-mcp-antigravity-driver-'));
  roots.push(root);
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  const cliPath = join(root, 'cli.js');
  const proxyPath = join(root, 'proxy.mjs');
  const launcherPath = join(root, process.platform === 'win32' ? 'agy.exe' : 'agy');
  await Promise.all([
    writeFile(cliPath, ''),
    writeFile(proxyPath, ''),
    writeFile(launcherPath, '', { mode: 0o700 }),
  ]);
  return { root, stateDirectory, cliPath, proxyPath, launcherPath };
}

describe('Antigravity CLI private driver', () => {
  it('builds one target-bound proxy config without a Discord credential', async () => {
    const paths = await workspace();
    const capturePath = join(paths.root, 'capture.jsonl');
    const config = buildAntigravityMcpConfig({
      nodePath: process.execPath,
      cliPath: paths.cliPath,
      proxyPath: paths.proxyPath,
      capturePath,
      target: TARGET,
      stateDirectory: paths.stateDirectory,
      mode: 'allow',
    });
    expect(config.mcpServers['discord-mcp']).toMatchObject({
      command: process.execPath,
      args: [
        paths.proxyPath,
        '--capture',
        capturePath,
        '--strip-env',
        'GEMINI_API_KEY',
        '--',
        process.execPath,
        paths.cliPath,
        'serve',
      ],
      env: {
        DISCORD_EXPECTED_BOT_ID: TARGET.botId,
        DISCORD_DEFAULT_GUILD_ID: TARGET.guildId,
        ALLOWED_GUILDS: TARGET.guildId,
        MCP_WRITE_MODE: 'allow',
        MCP_DRY_RUN: 'false',
      },
    });
    expect(JSON.stringify(config)).not.toContain('DISCORD_TOKEN');
    expect(() =>
      validateAntigravityMcpConfig(config, {
        nodePath: process.execPath,
        cliPath: paths.cliPath,
        proxyPath: paths.proxyPath,
        capturePath,
        target: TARGET,
        stateDirectory: paths.stateDirectory,
        mode: 'allow',
      }),
    ).not.toThrow();
  });

  it('allows only the exact lifecycle tools and denies built-in side effects', () => {
    const settings = buildAntigravityPermissions();
    expect(settings.permissions.allow).toEqual(
      ANTIGRAVITY_CLI_TOOLS.map((tool) => `mcp(discord-mcp/${tool})`),
    );
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'command(*)',
        'read_file(*)',
        'write_file(*)',
        'read_url(*)',
        'execute_url(*)',
      ]),
    );
    expect(settings.permissions.ask).toEqual([]);
  });

  it('creates isolated config/capture state, inherits the token only in memory, and cleans up', async () => {
    const paths = await workspace();
    const privateState = await prepareAntigravityPrivateState({
      target: TARGET,
      cliPath: paths.cliPath,
      proxyPath: paths.proxyPath,
      discordToken: TOKEN,
      stateDirectory: paths.stateDirectory,
      baseDirectory: paths.root,
      sourceEnv: { PATH: process.env.PATH, GEMINI_API_KEY: 'model-secret' },
    });
    const persisted = `${await readFile(privateState.mcpConfigPath, 'utf8')}\n${await readFile(
      privateState.settingsPath,
      'utf8',
    )}`;
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain('DISCORD_TOKEN');
    expect(persisted).not.toContain('model-secret');
    expect(privateState.environment).toMatchObject({
      DISCORD_TOKEN: TOKEN,
      GEMINI_API_KEY: 'model-secret',
      HOME: privateState.path,
      USERPROFILE: privateState.path,
    });
    expect(await readFile(privateState.capturePath, 'utf8')).toBe('');
    await privateState.cleanup();
    await expect(readFile(privateState.mcpConfigPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('resolves only a native launcher and refuses a shell shim', async () => {
    const paths = await workspace();
    const resolved = await resolveAntigravityLauncher({
      platform: process.platform,
      command: paths.launcherPath,
    });
    expect(resolved).toMatchObject({
      command: resolve(await realpath(paths.launcherPath)),
      kind: 'native',
    });
    if (process.platform === 'win32') {
      const shim = join(paths.root, 'agy.cmd');
      await writeFile(shim, '@echo off');
      await expect(
        resolveAntigravityLauncher({ platform: 'win32', command: shim }),
      ).rejects.toThrow('refusing shell fallback');
    }
  });

  it('builds a minimal child environment and never inherits unrelated secrets', async () => {
    const paths = await workspace();
    expect(
      buildAntigravityEnvironment({
        sourceEnv: {
          PATH: 'safe-path',
          GEMINI_API_KEY: 'model-key',
          ANTHROPIC_API_KEY: 'must-not-pass',
        },
        discordToken: TOKEN,
        privateHome: paths.root,
      }),
    ).toEqual({
      PATH: 'safe-path',
      GEMINI_API_KEY: 'model-key',
      DISCORD_TOKEN: TOKEN,
      HOME: paths.root,
      USERPROFILE: paths.root,
    });
  });
});
