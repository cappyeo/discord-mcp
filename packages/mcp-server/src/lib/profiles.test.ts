import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateProfile,
  type DiscordMcpProfile,
  listProfiles,
  loadProfile,
  normalizeProfileName,
  profilePath,
  removeProfile,
  resolveProfileDirectory,
  saveProfile,
} from './profiles.js';

const BOT_ID = '987654321098765432';
const GUILD_ID = '111122223333444455';
const TOKEN = `Bot ${'x'.repeat(60)}`;

function profile(overrides: Partial<DiscordMcpProfile> = {}): DiscordMcpProfile {
  return {
    version: 1,
    name: 'devbot',
    bot: { id: BOT_ID, username: 'DevBot' },
    credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
    allowedGuilds: [GUILD_ID],
    client: 'codex',
    toolSurface: 'progressive',
    gateway: false,
    ...overrides,
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-profiles-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('profile storage', () => {
  it('stores and loads only versioned non-secret metadata', () => {
    const path = saveProfile(profile(), { directory });

    expect(loadProfile('devbot', { directory })).toEqual(profile());
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('token');
    expect(raw).toContain('DISCORD_TOKEN');
  });

  it('lists profiles in stable name order', () => {
    saveProfile(profile({ name: 'zeta' }), { directory });
    saveProfile(profile({ name: 'alpha' }), { directory });

    expect(listProfiles({ directory }).map((item) => item.name)).toEqual(['alpha', 'zeta']);
  });

  it('requires explicit overwrite and keeps a profile locked to its original bot', () => {
    saveProfile(profile(), { directory });

    expect(() => saveProfile(profile(), { directory })).toThrow('--force');
    expect(() =>
      saveProfile(profile({ bot: { id: '999000999000999000', username: 'WrongBot' } }), {
        directory,
        overwrite: true,
      }),
    ).toThrow('locked to bot');
    expect(loadProfile('devbot', { directory }).bot.id).toBe(BOT_ID);
  });

  it('updates mutable metadata for the same bot when overwrite is explicit', () => {
    saveProfile(profile(), { directory });
    saveProfile(profile({ client: 'generic', toolSurface: 'full', gateway: true }), {
      directory,
      overwrite: true,
    });

    expect(loadProfile('devbot', { directory })).toMatchObject({
      client: 'generic',
      toolSurface: 'full',
      gateway: true,
      bot: { id: BOT_ID },
    });
  });

  it('rejects unknown fields so a token cannot be added to the profile schema', () => {
    const path = profilePath('devbot', { directory });
    writeFileSync(path, JSON.stringify({ ...profile(), token: TOKEN }), 'utf8');

    expect(() => loadProfile('devbot', { directory })).toThrow('unknown or missing fields');
  });

  it('removes exactly the selected profile', () => {
    saveProfile(profile({ name: 'keep' }), { directory });
    saveProfile(profile({ name: 'remove' }), { directory });

    removeProfile('remove', { directory });

    expect(listProfiles({ directory }).map((item) => item.name)).toEqual(['keep']);
  });
});

describe('profile activation', () => {
  it('applies safety settings while leaving the caller-owned token in the environment', () => {
    saveProfile(profile(), { directory });
    const targetEnv: NodeJS.ProcessEnv = { DISCORD_TOKEN: TOKEN, GATEWAY: '1' };

    const activated = activateProfile('devbot', { directory, targetEnv });

    expect(activated.bot.id).toBe(BOT_ID);
    expect(targetEnv.DISCORD_TOKEN).toBe(TOKEN);
    expect(targetEnv.DISCORD_EXPECTED_BOT_ID).toBe(BOT_ID);
    expect(targetEnv.ALLOWED_GUILDS).toBe(GUILD_ID);
    expect(targetEnv.MCP_TOOL_SURFACE).toBe('progressive');
    expect(targetEnv.GATEWAY).toBeUndefined();
  });

  it('fails before applying profile settings when the provider cannot resolve a token', () => {
    saveProfile(profile(), { directory });
    const targetEnv: NodeJS.ProcessEnv = { ALLOWED_GUILDS: 'old-value' };

    expect(() => activateProfile('devbot', { directory, targetEnv })).toThrow('DISCORD_TOKEN');
    expect(targetEnv.ALLOWED_GUILDS).toBe('old-value');
    expect(targetEnv.DISCORD_EXPECTED_BOT_ID).toBeUndefined();
  });
});

describe('profile paths and names', () => {
  it('uses platform configuration roots', () => {
    expect(
      resolveProfileDirectory({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
        homeDirectory: 'C:\\Users\\dev',
      }),
    ).toContain(join('discord-mcp', 'profiles'));
    expect(
      resolveProfileDirectory({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/tmp/config' },
        homeDirectory: '/home/dev',
      }),
    ).toBe(resolveProfileDirectory({ directory: '/tmp/config/discord-mcp/profiles' }));
  });

  it('rejects traversal and shell-hostile names', () => {
    expect(() => normalizeProfileName('../bot')).toThrow('Profile name');
    expect(() => normalizeProfileName('Bot Name')).toThrow('Profile name');
    expect(() => normalizeProfileName('devbot.')).toThrow('Profile name');
    expect(() => normalizeProfileName('con')).toThrow('Profile name');
    expect(normalizeProfileName('caller-bot_1.prod')).toBe('caller-bot_1.prod');
  });
});
