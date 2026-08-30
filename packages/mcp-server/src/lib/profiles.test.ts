import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateProfile,
  type DiscordMcpProfile,
  listProfiles,
  loadProfile,
  normalizeProfileCategories,
  normalizeProfileName,
  profileExists,
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
    categories: null,
    writeMode: 'allow',
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

  it('loads legacy profiles with permissive policy defaults', () => {
    const path = profilePath('devbot', { directory });
    const legacy = profile();
    delete (legacy as { categories?: unknown }).categories;
    delete (legacy as { writeMode?: unknown }).writeMode;
    writeFileSync(path, JSON.stringify(legacy), 'utf8');

    expect(loadProfile('devbot', { directory })).toMatchObject({
      categories: null,
      writeMode: 'allow',
    });
  });

  it('validates category names and duplicate entries', () => {
    expect(() =>
      saveProfile(profile({ categories: ['messages', 'messages'] }), { directory }),
    ).toThrow('duplicates');
    expect(() => saveProfile(profile({ categories: ['Messages'] }), { directory })).toThrow(
      'lowercase',
    );
  });

  it('keeps CLI empty-string semantics distinct from malformed stored arrays', () => {
    expect(normalizeProfileCategories(' ')).toBeNull();
    expect(() => normalizeProfileCategories([])).toThrow('lowercase');
    expect(() => normalizeProfileCategories([''])).toThrow('lowercase');
  });

  it.each([
    { categories: ['messages'] },
    { writeMode: 'preview' },
  ])('rejects a partially migrated policy record: %o', (partial) => {
    const path = profilePath('devbot', { directory });
    const legacy = { ...profile() } as Record<string, unknown>;
    delete legacy.categories;
    delete legacy.writeMode;
    writeFileSync(path, JSON.stringify({ ...legacy, ...partial }), 'utf8');
    expect(() => loadProfile('devbot', { directory })).toThrow(
      'requires both categories and writeMode',
    );
  });

  it('removes exactly the selected profile', () => {
    saveProfile(profile({ name: 'keep' }), { directory });
    saveProfile(profile({ name: 'remove' }), { directory });

    removeProfile('remove', { directory });

    expect(listProfiles({ directory }).map((item) => item.name)).toEqual(['keep']);
  });

  it('rejects profile file symlinks without reading, replacing, or removing their target', ({
    skip,
  }) => {
    const externalDirectory = join(directory, 'external');
    const externalPath = join(externalDirectory, 'devbot.json');
    const target = profilePath('devbot', { directory });
    const externalContent = JSON.stringify(profile());
    mkdirSync(externalDirectory);
    writeFileSync(externalPath, externalContent, 'utf8');
    try {
      symlinkSync(externalPath, target, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }

    expect(() => profileExists('devbot', { directory })).toThrow('bounded regular file');
    expect(() => loadProfile('devbot', { directory })).toThrow('bounded regular file');
    expect(() => saveProfile(profile(), { directory, overwrite: true })).toThrow(
      'bounded regular file',
    );
    expect(() => removeProfile('devbot', { directory })).toThrow('bounded regular file');
    expect(listProfiles({ directory })).toEqual([]);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath, 'utf8')).toBe(externalContent);
  });

  it('rejects a symlinked profile directory without touching its contents', ({ skip }) => {
    const externalDirectory = join(directory, 'external-profiles');
    const linkedDirectory = join(directory, 'linked-profiles');
    const externalPath = join(externalDirectory, 'devbot.json');
    const externalContent = JSON.stringify(profile());
    mkdirSync(externalDirectory);
    writeFileSync(externalPath, externalContent, 'utf8');
    try {
      symlinkSync(externalDirectory, linkedDirectory, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }

    const options = { directory: linkedDirectory };
    expect(() => profileExists('devbot', options)).toThrow('regular directory');
    expect(() => loadProfile('devbot', options)).toThrow('regular directory');
    expect(() => listProfiles(options)).toThrow('regular directory');
    expect(() => saveProfile(profile(), { ...options, overwrite: true })).toThrow(
      'regular directory',
    );
    expect(() => removeProfile('devbot', options)).toThrow('regular directory');
    expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath, 'utf8')).toBe(externalContent);
  });

  it('rejects oversized profile files by UTF-8 bytes before parsing them', () => {
    const path = profilePath('devbot', { directory });
    writeFileSync(path, 'é'.repeat(512 * 1024 + 1), 'utf8');

    expect(() => profileExists('devbot', { directory })).toThrow('bounded regular file');
    expect(() => loadProfile('devbot', { directory })).toThrow('bounded regular file');
  });
});

describe('profile activation', () => {
  it('applies safety settings while leaving the caller-owned token in the environment', () => {
    saveProfile(profile(), { directory });
    const targetEnv: NodeJS.ProcessEnv = {
      DISCORD_TOKEN: TOKEN,
      GATEWAY: '1',
      MCP_CATEGORIES: 'ambient',
    };

    const activated = activateProfile('devbot', { directory, targetEnv });

    expect(activated.bot.id).toBe(BOT_ID);
    expect(targetEnv.DISCORD_TOKEN).toBe(TOKEN);
    expect(targetEnv.DISCORD_EXPECTED_BOT_ID).toBe(BOT_ID);
    expect(targetEnv.ALLOWED_GUILDS).toBe(GUILD_ID);
    expect(targetEnv.MCP_TOOL_SURFACE).toBe('progressive');
    expect(targetEnv.MCP_CATEGORIES).toBeUndefined();
    expect(targetEnv.MCP_WRITE_MODE).toBe('allow');
    expect(targetEnv.GATEWAY).toBeUndefined();
  });

  it('activates a scoped preview profile and replaces ambient policy', () => {
    saveProfile(profile({ categories: ['messages', 'guild'], writeMode: 'preview' }), {
      directory,
    });
    const targetEnv: NodeJS.ProcessEnv = {
      DISCORD_TOKEN: TOKEN,
      MCP_CATEGORIES: 'ambient',
      MCP_WRITE_MODE: 'allow',
    };
    activateProfile('devbot', { directory, targetEnv });
    expect(targetEnv.MCP_CATEGORIES).toBe('messages,guild');
    expect(targetEnv.MCP_WRITE_MODE).toBe('preview');
  });

  it('leaves the separate destructive dry-run arm caller-controlled', () => {
    saveProfile(profile({ writeMode: 'allow' }), { directory });
    const targetEnv: NodeJS.ProcessEnv = {
      DISCORD_TOKEN: TOKEN,
      MCP_DRY_RUN: 'false',
    };
    activateProfile('devbot', { directory, targetEnv });
    expect(targetEnv.MCP_DRY_RUN).toBe('false');
    expect(targetEnv.MCP_WRITE_MODE).toBe('allow');
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
