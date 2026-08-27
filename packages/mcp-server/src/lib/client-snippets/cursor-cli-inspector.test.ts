import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordMcpProfile } from '../profiles.js';
import { CursorCliConfigError, inspectCursorCliConfig } from './cursor-cli-inspector.js';

const profile: DiscordMcpProfile = {
  version: 1,
  name: 'devbot',
  bot: { id: '123456789012345678', username: 'DevBot' },
  credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
  allowedGuilds: ['987654321098765432'],
  client: 'cursor-cli',
  toolSurface: 'progressive',
  gateway: false,
};

let directory: string;
let configPath: string;

function writeConfig(profileName = 'devbot', extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          'discord-mcp': {
            command: 'npx',
            args: [
              '--yes',
              '--loglevel=error',
              '@discord-mcp/cli@0.24.0',
              'serve',
              '--profile',
              profileName,
            ],
            ...extra,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-cursor-cli-inspector-'));
  const configDirectory = join(directory, '.cursor');
  mkdirSync(configDirectory, { recursive: true });
  configPath = join(configDirectory, 'mcp.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('inspectCursorCliConfig', () => {
  it('accepts the generated launcher and returns only secret-safe metadata', () => {
    writeConfig();

    expect(inspectCursorCliConfig(profile, { config: configPath })).toEqual({
      configName: 'discord-mcp',
      currentVersion: '0.24.0',
      environmentForwarding: 'inherited',
      credentialPersisted: false,
    });
  });

  it.each([
    'discord_token',
    'CuRsOr_ApI_kEy',
  ])('fails closed when the config persists %s without echoing the value', (credentialName) => {
    const secret = `secret-${'s'.repeat(60)}`;
    writeConfig('devbot', { env: { [credentialName]: secret } });

    let failure: unknown;
    try {
      inspectCursorCliConfig(profile, { config: configPath });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CursorCliConfigError);
    expect((failure as CursorCliConfigError).kind).toBe('credential-persisted');
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it('rejects a credential name outside the selected server entry', () => {
    writeConfig();
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, CURSOR_API_KEY: 'do-not-echo' }));

    expect(() => inspectCursorCliConfig(profile, { config: configPath })).toThrow(
      'Cursor Agent MCP config must inherit credentials instead of storing them',
    );
  });

  it('rejects a launcher bound to another profile', () => {
    writeConfig('otherbot');

    expect(() => inspectCursorCliConfig(profile, { config: configPath })).toThrow(
      'generated Cursor Agent launcher is not bound to the selected profile',
    );
  });

  it('uses the documented global MCP config path by default', () => {
    writeConfig();

    expect(inspectCursorCliConfig(profile, { homeDirectory: directory }).currentVersion).toBe(
      '0.24.0',
    );
  });

  it('rejects malformed and oversized configs without reflecting their content', () => {
    writeFileSync(configPath, '{"mcpServers":{"discord-mcp":{"CURSOR_API_KEY":"secret');
    expect(() => inspectCursorCliConfig(profile, { config: configPath })).toThrow(
      'could not parse Cursor Agent MCP config',
    );

    writeFileSync(configPath, 'x'.repeat(1024 * 1024 + 1));
    expect(() => inspectCursorCliConfig(profile, { config: configPath })).toThrow(
      'Cursor Agent MCP config must be a bounded regular file',
    );
  });

  it.runIf(process.platform !== 'win32')('rejects symlinked configs', () => {
    const target = join(directory, 'replacement.json');
    writeConfig();
    writeFileSync(target, '{}');
    rmSync(configPath);
    symlinkSync(target, configPath, 'file');

    expect(() => inspectCursorCliConfig(profile, { config: configPath })).toThrow(
      'Cursor Agent MCP config must be a bounded regular file',
    );
  });
});
