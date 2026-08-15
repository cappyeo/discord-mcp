import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createActivationDependencies,
  createActivationWorkspace,
  hashActivationPackageTree,
} from './activation-dependencies.mjs';

const TARGET = { guildId: '1537332825978568744', botId: '1537332825978568745' };

describe('activation dependency substrate', () => {
  it('creates an isolated workspace and verifies removal', async () => {
    const workspace = createActivationWorkspace({ host: 'fixture' });
    const state = await workspace.create({ trialId: 'trial-001' });

    expect(state.root).toContain('discord-mcp-fixture-trial-001-');
    expect(state.configPath).toBe(join(state.home, 'config.toml'));
    expect(state.profileEnvironmentKey).toBe(
      process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME',
    );
    expect(state.cleanProfile).toBe(true);
    if (process.platform !== 'win32') {
      for (const path of [
        state.root,
        state.home,
        state.installRoot,
        state.profileRoot,
        state.stateDirectory,
      ]) {
        expect((await lstat(path)).mode & 0o077).toBe(0);
      }
    }

    const removed = await workspace.remove(state.root);
    expect(removed).toEqual({ removed: true, verified: true });
  });

  it('rejects an aborted workspace creation before allocating a temporary root', async () => {
    const workspace = createActivationWorkspace({ host: 'fixture' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      workspace.create({ trialId: 'trial-aborted', signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('supports a Claude-style config basename and rejects traversal before creation', async () => {
    const workspace = createActivationWorkspace({ host: 'claude', configFileName: 'mcp.json' });
    const state = await workspace.create({ trialId: 'trial-001' });
    expect(state.configPath).toBe(join(state.home, 'mcp.json'));
    await workspace.remove(state.root);

    expect(() => createActivationWorkspace({ configFileName: '../mcp.json' })).toThrow(
      /safe basename/,
    );
    expect(() => createActivationWorkspace({ configFileName: 'C:\\mcp.json' })).toThrow(
      /safe basename/,
    );
    expect(() => createActivationWorkspace({ configFileName: '/tmp/mcp.json' })).toThrow(
      /safe basename/,
    );
  });

  it('hashes package trees deterministically and rejects an empty tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-hash-'));
    try {
      await mkdir(join(root, 'nested'));
      await writeFile(join(root, 'z.txt'), 'z');
      await writeFile(join(root, 'nested', 'a.txt'), 'a');
      const first = await hashActivationPackageTree(root);
      const second = await hashActivationPackageTree(root);
      expect(first).toBe(second);
      expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const empty = await mkdtemp(join(tmpdir(), 'discord-mcp-empty-'));
    try {
      await expect(hashActivationPackageTree(empty)).rejects.toThrow('contains no files');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('keeps setup token scoped to the guided setup child environment', async () => {
    let command;
    const dependencies = createActivationDependencies({
      host: 'fixture',
      environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'must-not-leak' },
      runCommand: async (...args) => {
        command = args;
        const configPath = args[1][args[1].indexOf('--output') + 1];
        await writeFile(
          configPath,
          'command = "npx"\nargs = ["@discord-mcp/cli@0.22.0"]\n',
          'utf8',
        );
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { discord: { bot: { id: TARGET.botId } }, allowedGuilds: [TARGET.guildId] },
          }),
          stderr: '',
        };
      },
      setupArgs: ({ configPath }) => ['setup', '--output', configPath],
      parseSetup: (_stdout, target) => ({
        binding: target,
        bindingVerified: true,
      }),
      assertConfigReady: () => true,
      assertConfigWritable: () => true,
      enableWrites: async () => ({ config: '' }),
      createLiveAdapter: () => ({
        async launch() {},
        async apply() {},
        async evidence() {},
        async captureBaseline() {},
        async restoreBaseline() {},
        async verifyBaseline() {},
        async closeSession() {},
      }),
      executionProvenance: {
        execution_mode: 'test',
        adapter_id: 'fixture-adapter',
        abortable: true,
        package_source: 'test_fixture',
      },
    });
    const state = await dependencies.workspace.create({ trialId: 'trial-001' });
    const result = await dependencies.setup({
      release: '0.22.0',
      profile: 'activation-trial-001',
      target: TARGET,
      configPath: state.configPath,
      home: state.home,
      profileRoot: state.profileRoot,
      installRoot: state.installRoot,
      token: 'discord-token-only-for-setup',
    });

    expect(result.bindingVerified).toBe(true);
    expect(command[2].env.DISCORD_TOKEN).toBe('discord-token-only-for-setup');
    expect(command[2].env[state.profileEnvironmentKey]).toBe(state.profileRoot);
    expect(command[2].env.ANTHROPIC_API_KEY).toBeUndefined();
    await dependencies.workspace.remove(state.root);
  });
});
