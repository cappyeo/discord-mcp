import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordMcpProfile } from '../profiles.js';
import {
  AntigravityCliConfigError,
  inspectAntigravityCliConfig,
} from './antigravity-cli-inspector.js';

const profile: DiscordMcpProfile = {
  version: 1,
  name: 'devbot',
  bot: { id: '123456789012345678', username: 'DevBot' },
  credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
  allowedGuilds: ['987654321098765432'],
  client: 'antigravity-cli',
  toolSurface: 'progressive',
  gateway: false,
};

let directory: string;
let configPath: string;

function writeConfig(profileName = 'devbot', env: Record<string, string> | undefined = undefined) {
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
              '@discord-mcp/cli@0.25.1',
              'serve',
              '--profile',
              profileName,
            ],
            ...(env === undefined ? {} : { env }),
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-antigravity-inspector-'));
  const configDirectory = join(directory, '.gemini', 'config');
  mkdirSync(configDirectory, { recursive: true });
  configPath = join(configDirectory, 'mcp_config.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('inspectAntigravityCliConfig', () => {
  it('accepts the generated launcher and returns only secret-safe metadata', () => {
    writeConfig();

    expect(inspectAntigravityCliConfig(profile, { config: configPath })).toEqual({
      configName: 'discord-mcp',
      currentVersion: '0.25.1',
      environmentForwarding: 'inherited',
      credentialPersisted: false,
    });
  });

  it('fails closed when the config contains a Discord token without echoing it', () => {
    const secret = `Bot ${'s'.repeat(60)}`;
    writeConfig('devbot', { discord_token: secret });

    let failure: unknown;
    try {
      inspectAntigravityCliConfig(profile, { config: configPath });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AntigravityCliConfigError);
    expect((failure as AntigravityCliConfigError).kind).toBe('credential-persisted');
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it('rejects a launcher bound to another profile', () => {
    writeConfig('otherbot');

    expect(() => inspectAntigravityCliConfig(profile, { config: configPath })).toThrow(
      'generated Antigravity CLI launcher is not bound to the selected profile',
    );
  });

  it('uses the documented global MCP config path by default', () => {
    writeConfig();

    expect(inspectAntigravityCliConfig(profile, { homeDirectory: directory }).currentVersion).toBe(
      '0.25.1',
    );
  });

  it('rejects malformed and oversized configs without reflecting their content', () => {
    writeFileSync(configPath, '{"mcpServers":{"discord-mcp":{"env":{"DISCORD_TOKEN":"secret');
    expect(() => inspectAntigravityCliConfig(profile, { config: configPath })).toThrow(
      'could not parse Antigravity CLI MCP config',
    );

    writeFileSync(configPath, 'x'.repeat(1024 * 1024 + 1));
    expect(() => inspectAntigravityCliConfig(profile, { config: configPath })).toThrow(
      'Antigravity CLI MCP config must be a bounded regular file',
    );
  });

  it.runIf(process.platform !== 'win32')('rejects symlinked configs', () => {
    const target = join(directory, 'replacement.json');
    writeConfig();
    writeFileSync(target, '{}');
    rmSync(configPath);
    symlinkSync(target, configPath, 'file');

    expect(() => inspectAntigravityCliConfig(profile, { config: configPath })).toThrow(
      'Antigravity CLI MCP config must be a bounded regular file',
    );
  });
});
