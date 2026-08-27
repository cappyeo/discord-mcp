import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscordMcpProfile } from '../profiles.js';
import { GeminiCliConfigError, inspectGeminiCliConfig } from './gemini-cli-inspector.js';

const profile: DiscordMcpProfile = {
  version: 1,
  name: 'devbot',
  bot: { id: '123456789012345678', username: 'DevBot' },
  credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
  allowedGuilds: ['987654321098765432'],
  client: 'gemini-cli',
  toolSurface: 'progressive',
  gateway: false,
};

let directory: string;
let configPath: string;

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini interpolation
function writeConfig(tokenReference = '${DISCORD_TOKEN}', profileName = 'devbot'): void {
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
            env: { DISCORD_TOKEN: tokenReference },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-gemini-inspector-'));
  const configDirectory = join(directory, '.gemini');
  mkdirSync(configDirectory);
  configPath = join(configDirectory, 'settings.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('inspectGeminiCliConfig', () => {
  it('accepts the exact generated launcher and returns only secret-safe metadata', () => {
    writeConfig();

    expect(inspectGeminiCliConfig(profile, { config: configPath })).toEqual({
      configName: 'discord-mcp',
      currentVersion: '0.24.0',
      environmentForwarding: true,
      credentialPersisted: false,
    });
  });

  it('fails closed when Gemini materialized the token without echoing it', () => {
    const secret = `Bot ${'s'.repeat(60)}`;
    writeConfig(secret);

    let failure: unknown;
    try {
      inspectGeminiCliConfig(profile, { config: configPath });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GeminiCliConfigError);
    expect((failure as GeminiCliConfigError).kind).toBe('credential-materialized');
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it('rejects a launcher bound to another profile', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini interpolation
    writeConfig('${DISCORD_TOKEN}', 'otherbot');

    expect(() => inspectGeminiCliConfig(profile, { config: configPath })).toThrow(
      'generated Gemini CLI launcher is not bound to the selected profile',
    );
  });

  it('rejects malformed settings without reflecting their content', () => {
    const malformed = '{"mcpServers":{"discord-mcp":{"env":{"DISCORD_TOKEN":"secret';
    writeFileSync(configPath, malformed);

    expect(() => inspectGeminiCliConfig(profile, { config: configPath })).toThrow(
      'could not parse Gemini CLI settings',
    );
  });

  it('uses the documented user settings path by default', () => {
    writeConfig();

    expect(inspectGeminiCliConfig(profile, { homeDirectory: directory }).currentVersion).toBe(
      '0.24.0',
    );
  });

  it('follows Gemini CLI home isolation without reading unrelated user settings', () => {
    writeConfig();

    expect(
      inspectGeminiCliConfig(profile, { env: { GEMINI_CLI_HOME: directory } }).currentVersion,
    ).toBe('0.24.0');
  });

  it('rejects oversized settings before parsing them', () => {
    writeFileSync(configPath, 'x'.repeat(1024 * 1024 + 1));

    expect(() => inspectGeminiCliConfig(profile, { config: configPath })).toThrow(
      'Gemini CLI settings must be a bounded regular file',
    );
  });

  it.runIf(process.platform !== 'win32')('rejects symlinked settings', () => {
    const target = join(directory, 'replacement.json');
    writeConfig();
    writeFileSync(target, '{}');
    rmSync(configPath);
    symlinkSync(target, configPath, 'file');

    expect(() => inspectGeminiCliConfig(profile, { config: configPath })).toThrow(
      'Gemini CLI settings must be a bounded regular file',
    );
  });
});
