import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildGrokCliEnvironment,
  buildGrokCliMcpConfig,
  prepareGrokCliPrivateState,
  resolveGrokCliLauncher,
  validateGrokCliMcpConfig,
} from './grok-cli-driver.mjs';

const TARGET = { guildId: '1537332825978568744', botId: '1533719084636700773' };
const DISCORD_TOKEN = 'fixture.discord.token';
const XAI_API_KEY = 'fixture-xai-key';
const roots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grok-cli-driver-test-'));
  roots.push(root);
  const state = join(root, 'state');
  await mkdir(state);
  const cli = join(root, 'grok');
  const proxy = join(root, 'proxy.mjs');
  await Promise.all([writeFile(cli, '', 'utf8'), writeFile(proxy, '', 'utf8')]);
  if (process.platform !== 'win32') await chmod(cli, 0o700);
  return { root, state, cli, proxy };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Grok CLI activation driver', () => {
  it('builds target-bound mcp_servers config without either credential value', async () => {
    const item = await fixture();
    const capture = join(item.root, 'capture.jsonl');
    await writeFile(capture, '', 'utf8');
    const config = buildGrokCliMcpConfig({
      nodePath: process.execPath,
      cliPath: item.cli,
      proxyPath: item.proxy,
      capturePath: capture,
      target: TARGET,
      stateDirectory: item.state,
      mode: 'allow',
    });
    const server = config.mcp_servers['discord-mcp'];
    expect(server).toMatchObject({ enabled: true, startup_timeout_sec: 90 });
    expect(server.env).toMatchObject({
      DISCORD_EXPECTED_BOT_ID: TARGET.botId,
      DISCORD_DEFAULT_GUILD_ID: TARGET.guildId,
      MCP_WRITE_MODE: 'allow',
      MCP_DRY_RUN: 'false',
    });
    expect(JSON.stringify(config)).not.toContain(DISCORD_TOKEN);
    expect(JSON.stringify(config)).not.toContain(XAI_API_KEY);
    expect(
      validateGrokCliMcpConfig(config, {
        nodePath: process.execPath,
        cliPath: item.cli,
        proxyPath: item.proxy,
        capturePath: capture,
        target: TARGET,
        stateDirectory: item.state,
        mode: 'allow',
      }),
    ).toBe(true);
  });

  it('keeps Grok auth and Discord token in process memory only', async () => {
    const item = await fixture();
    const environment = buildGrokCliEnvironment({
      sourceEnv: { PATH: '/bin', XAI_API_KEY, UNRELATED_SECRET: 'drop-me' },
      discordToken: DISCORD_TOKEN,
      privateHome: item.root,
    });
    expect(environment).toMatchObject({
      PATH: '/bin',
      XAI_API_KEY,
      DISCORD_TOKEN,
      GROK_HOME: item.root,
      HOME: item.root,
    });
    expect(environment).not.toHaveProperty('UNRELATED_SECRET');
  });

  it('prepares and removes an isolated Grok settings file', async () => {
    const item = await fixture();
    const privateState = await prepareGrokCliPrivateState({
      target: TARGET,
      cliPath: item.cli,
      nodePath: process.execPath,
      proxyPath: item.proxy,
      discordToken: DISCORD_TOKEN,
      stateDirectory: item.state,
      sourceEnv: { PATH: '/bin', XAI_API_KEY },
      baseDirectory: item.root,
      platform: process.platform,
    });
    const saved = await readFile(privateState.settingsPath, 'utf8');
    expect(saved).not.toContain(DISCORD_TOKEN);
    expect(saved).toContain('[mcp_servers.discord-mcp]');
    expect(saved).not.toContain(XAI_API_KEY);
    expect(privateState.settingsPath).toMatch(/config\.toml$/u);
    expect(privateState.environment.XAI_API_KEY).toBe(XAI_API_KEY);
    await privateState.cleanup();
    await expect(readFile(privateState.settingsPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'resolves only the explicit grok executable',
    async () => {
      const item = await fixture();
      await expect(
        resolveGrokCliLauncher({
          platform: 'linux',
          run: async () => ({ stdout: `${item.cli}\n` }),
        }),
      ).resolves.toMatchObject({ command: item.cli, kind: 'native' });
      await expect(
        resolveGrokCliLauncher({
          platform: 'linux',
          command: 'agent',
          run: async () => ({ stdout: '' }),
        }),
      ).rejects.toThrow('unavailable');
    },
  );

  it('rejects credential materialization and target drift', async () => {
    const item = await fixture();
    const capture = join(item.root, 'capture.jsonl');
    await writeFile(capture, '', 'utf8');
    const config = buildGrokCliMcpConfig({
      nodePath: process.execPath,
      cliPath: item.cli,
      proxyPath: item.proxy,
      capturePath: capture,
      target: TARGET,
      stateDirectory: item.state,
    });
    config.mcp_servers['discord-mcp'].env.GROK_SECRET = XAI_API_KEY;
    expect(() =>
      validateGrokCliMcpConfig(config, {
        nodePath: process.execPath,
        cliPath: item.cli,
        proxyPath: item.proxy,
        capturePath: capture,
        target: TARGET,
        stateDirectory: item.state,
      }),
    ).toThrow('target-bound contract');
  });
});
