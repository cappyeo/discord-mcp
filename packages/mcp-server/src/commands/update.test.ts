import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProfile } from '../lib/profiles.js';
import { updateAction } from './update.js';

const CURRENT = '0.14.6';
const NEXT = '0.14.7';
const originalExitCode = process.exitCode;

let directory: string;
let profileDirectory: string;
let configPath: string;
let stdoutWrites: string[];

function generatedLauncher(profile = 'devbot', version = CURRENT): string {
  return [
    '[mcp_servers.discord-mcp]',
    'command = "npx"',
    `args = ["--yes", "--loglevel=error", "@discord-mcp/cli@${version}", "serve", "--profile", "${profile}"]`,
    'env_vars = ["DISCORD_TOKEN"]',
    '',
  ].join('\n');
}

function createProfile(client: 'codex' | 'generic' = 'codex', name = 'devbot'): void {
  saveProfile(
    {
      version: 1,
      name,
      bot: { id: '123456789012345678', username: 'update-bot' },
      credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
      allowedGuilds: ['987654321098765432'],
      client,
      toolSurface: 'progressive',
      gateway: false,
    },
    { directory: profileDirectory },
  );
}

function registry(version = NEXT): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ 'dist-tags': { latest: version } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function output(): Record<string, unknown> {
  return JSON.parse(stdoutWrites.join('')) as Record<string, unknown>;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-update-'));
  profileDirectory = join(directory, 'profiles');
  configPath = join(directory, 'config.toml');
  stdoutWrites = [];
  process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

describe('updateAction', () => {
  it('reports an available update without changing the launcher', async () => {
    createProfile();
    writeFileSync(configPath, generatedLauncher());
    registry();

    await updateAction({ profile: 'devbot', config: configPath, profileDirectory, json: true });

    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({
      ok: false,
      summary: `update available: ${CURRENT} -> ${NEXT}`,
      data: {
        profile: 'devbot',
        currentVersion: CURRENT,
        targetVersion: NEXT,
        updateAvailable: true,
      },
    });
    expect(readFileSync(configPath, 'utf8')).toBe(generatedLauncher());
  });

  it('updates only the exact generated launcher after --apply', async () => {
    createProfile();
    const other = generatedLauncher('otherbot').replace('discord-mcp]', 'other]');
    writeFileSync(configPath, `${generatedLauncher()}${other}`);
    registry();

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(process.exitCode).toBe(0);
    expect(output()).toMatchObject({
      ok: true,
      summary: `updated Codex launcher: ${CURRENT} -> ${NEXT}`,
      data: {
        profile: 'devbot',
        currentVersion: CURRENT,
        targetVersion: NEXT,
        applied: true,
        restart_required: true,
        settings_migrated: ['tool_timeout_sec'],
      },
    });
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain(`@discord-mcp/cli@${NEXT}", "serve", "--profile", "devbot`);
    expect(config).toContain(`@discord-mcp/cli@${CURRENT}", "serve", "--profile", "otherbot`);
    expect(config.match(/^tool_timeout_sec = 180$/gm)).toHaveLength(1);
  });

  it('preserves a caller-defined Codex tool timeout during an update', async () => {
    createProfile();
    const configured = generatedLauncher().replace(
      'env_vars = ["DISCORD_TOKEN"]',
      'tool_timeout_sec = 60\nenv_vars = ["DISCORD_TOKEN"]',
    );
    writeFileSync(configPath, configured);
    registry();

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(output()).toMatchObject({
      ok: true,
      data: { settings_migrated: [] },
    });
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain(`@discord-mcp/cli@${NEXT}`);
    expect(config).toContain('tool_timeout_sec = 60');
    expect(config).not.toContain('tool_timeout_sec = 180');
  });

  it('lets a newer CLI update an older pinned launcher', async () => {
    createProfile();
    writeFileSync(configPath, generatedLauncher('devbot', '0.14.5'));
    registry();

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(process.exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toContain(`@discord-mcp/cli@${NEXT}`);
  });

  it('does not change custom launchers', async () => {
    createProfile();
    const config = [
      '[mcp_servers.discord-mcp]',
      'command = "powershell.exe"',
      'args = ["-Command", "npx --yes @discord-mcp/cli@0.14.6 serve --profile devbot"]',
      '',
    ].join('\n');
    writeFileSync(configPath, config);
    registry();

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(process.exitCode).toBe(2);
    expect(output().summary).toBe('could not identify exactly one generated Codex launcher');
    expect(readFileSync(configPath, 'utf8')).toBe(config);
  });

  it('fails closed when more than one generated launcher targets the profile', async () => {
    createProfile();
    const duplicate = generatedLauncher().replace('discord-mcp]', 'discord-mcp-duplicate]');
    const config = `${generatedLauncher()}${duplicate}`;
    writeFileSync(configPath, config);
    registry();

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(process.exitCode).toBe(2);
    expect(output()).toMatchObject({
      summary: 'could not identify exactly one generated Codex launcher',
    });
    expect(readFileSync(configPath, 'utf8')).toBe(config);
  });

  it('refuses profiles generated for another client before a registry request', async () => {
    createProfile('generic');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await updateAction({ profile: 'devbot', config: configPath, profileDirectory, json: true });

    expect(process.exitCode).toBe(2);
    expect(output()).toMatchObject({ summary: 'profile devbot is not a Codex profile' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not modify the config when the npm registry fails', async () => {
    createProfile();
    const config = generatedLauncher();
    writeFileSync(configPath, config);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    await updateAction({
      profile: 'devbot',
      apply: true,
      config: configPath,
      profileDirectory,
      json: true,
    });

    expect(process.exitCode).toBe(2);
    expect(output()).toMatchObject({ summary: 'could not check for an update' });
    expect(readFileSync(configPath, 'utf8')).toBe(config);
  });

  it('rejects conflicting check and apply flags before reading local state', async () => {
    await updateAction({ profile: 'devbot', check: true, apply: true, json: true });

    expect(process.exitCode).toBe(2);
    expect(output()).toMatchObject({ summary: '--check and --apply cannot be used together' });
  });
});
