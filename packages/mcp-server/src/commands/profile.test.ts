import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProfile } from '../lib/profiles.js';
import { profileListAction, profileRemoveAction, profileShowAction } from './profile.js';

const BOT_ID = '987654321098765432';
const GUILD_ID = '111122223333444455';
const originalExitCode = process.exitCode;
const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;

let directory: string;
let stdoutWrites: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-profile-command-'));
  stdoutWrites = [];
  process.exitCode = 0;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  saveProfile(
    {
      version: 1,
      name: 'devbot',
      bot: { id: BOT_ID, username: 'DevBot' },
      credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
      allowedGuilds: [GUILD_ID],
      client: 'codex',
      toolSurface: 'progressive',
      gateway: false,
    },
    { directory },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = originalExitCode;
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutTTY,
    configurable: true,
  });
});

function output(): string {
  return stdoutWrites.join('');
}

describe('profile commands', () => {
  it('lists and shows non-secret profile metadata', () => {
    profileListAction({ json: true, profileDirectory: directory });
    const listed = JSON.parse(output());
    expect(listed.data.profiles).toHaveLength(1);
    expect(listed.data.profiles[0].credential).toEqual({
      provider: 'env',
      variable: 'DISCORD_TOKEN',
    });
    expect(listed.data.profiles[0]).toMatchObject({ categories: null, writeMode: 'allow' });

    stdoutWrites = [];
    profileShowAction('devbot', { json: true, profileDirectory: directory });
    const shown = JSON.parse(output());
    expect(shown.data.profile.bot.id).toBe(BOT_ID);
    expect(shown.data.profile).toMatchObject({ categories: null, writeMode: 'allow' });
    expect(output()).not.toContain('Bot x');
  });

  it('refuses non-interactive removal without --yes', async () => {
    await profileRemoveAction('devbot', { json: true, profileDirectory: directory });

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(output()).errors[0]).toContain('--yes');
    stdoutWrites = [];
    profileShowAction('devbot', { json: true, profileDirectory: directory });
    expect(process.exitCode).toBe(0);
  });

  it('removes one profile with explicit confirmation and states that the token is not revoked', async () => {
    await profileRemoveAction('devbot', {
      yes: true,
      json: true,
      profileDirectory: directory,
    });

    const result = JSON.parse(output());
    expect(result.ok).toBe(true);
    expect(result.data.tokenRevoked).toBe(false);
    expect(result.details.join(' ')).toContain('not revoked');
  });

  it('can explicitly remove a corrupt profile that cannot be loaded', async () => {
    writeFileSync(join(directory, 'devbot.json'), '{broken json', 'utf8');

    await profileRemoveAction('devbot', {
      yes: true,
      json: true,
      profileDirectory: directory,
    });

    expect(JSON.parse(output()).ok).toBe(true);
  });
});
