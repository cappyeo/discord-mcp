import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProfile } from '../lib/profiles.js';
import { setupAction } from './setup.js';

const BOT = { id: '987654321098765432', username: 'DevBot', bot: true };
const OTHER_BOT = { id: '999000999000999000', username: 'OtherBot', bot: true };
const GUILD = { id: '111122223333444455', name: 'Test Guild', permissions: '0' };
const TOKEN = `Bot ${'x'.repeat(60)}`;

const originalDiscordToken = process.env.DISCORD_TOKEN;
const originalExitCode = process.exitCode;
const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;

let directory: string;
let stdoutWrites: string[];

function stubDiscord(bot = BOT): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/users/@me')) return new Response(JSON.stringify(bot), { status: 200 });
      if (url.includes('/users/@me/guilds')) {
        return new Response(JSON.stringify([GUILD]), { status: 200 });
      }
      throw new Error(`unexpected Discord URL: ${url}`);
    }),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-setup-'));
  stdoutWrites = [];
  process.env.DISCORD_TOKEN = TOKEN;
  process.exitCode = 0;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  stubDiscord();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  if (originalDiscordToken === undefined) {
    delete process.env.DISCORD_TOKEN;
  } else {
    process.env.DISCORD_TOKEN = originalDiscordToken;
  }
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

function result(): {
  ok: boolean;
  data?: { content?: string; profile?: { name: string; path: string } };
  errors?: string[];
} {
  return JSON.parse(stdoutWrites.join(''));
}

describe('guided caller-owned bot setup', () => {
  it('creates a non-secret profile and a client config that activates it at runtime', async () => {
    await setupAction({
      profile: 'devbot',
      client: 'codex',
      json: true,
      profileDirectory: directory,
    });

    const parsed = result();
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.content).toContain('"serve", "--profile", "devbot"');
    expect(parsed.data?.content).toContain('env_vars = ["DISCORD_TOKEN"]');
    expect(parsed.data?.content).not.toContain(TOKEN);
    expect(parsed.data?.content).not.toContain('DISCORD_EXPECTED_BOT_ID');

    const saved = loadProfile('devbot', { directory });
    expect(saved).toMatchObject({
      bot: { id: BOT.id, username: BOT.username },
      allowedGuilds: [GUILD.id],
      client: 'codex',
      toolSurface: 'progressive',
    });
    expect(readFileSync(parsed.data?.profile?.path ?? '', 'utf8')).not.toContain(TOKEN);
  });

  it('lets JSON clients inherit the provider environment without a literal placeholder', async () => {
    await setupAction({
      profile: 'devbot',
      client: 'generic',
      json: true,
      profileDirectory: directory,
    });

    const content = JSON.parse(result().data?.content ?? '{}');
    expect(content.mcpServers['discord-mcp'].args).toContain('devbot');
    expect(content.mcpServers['discord-mcp'].env).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder must be absent
    expect(result().data?.content).not.toContain('${env:DISCORD_TOKEN}');
    expect(result().data?.content).not.toContain(TOKEN);
  });

  it('does not let --force reassign an existing profile to another bot', async () => {
    await setupAction({
      profile: 'devbot',
      client: 'codex',
      json: true,
      profileDirectory: directory,
    });
    stdoutWrites = [];
    process.exitCode = 0;
    stubDiscord(OTHER_BOT);

    await setupAction({
      profile: 'devbot',
      client: 'codex',
      json: true,
      force: true,
      profileDirectory: directory,
    });

    expect(process.exitCode).toBe(2);
    expect(result().errors?.[0]).toContain('locked to bot');
    expect(loadProfile('devbot', { directory }).bot.id).toBe(BOT.id);
  });
});
