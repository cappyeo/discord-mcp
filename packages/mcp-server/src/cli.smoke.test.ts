/**
 * CLI binary smoke test (Plan 9 Phase F).
 *
 * Spawns the built `dist/cli.js` as a real subprocess and asserts:
 * 1. `--version` prints the package version.
 * 2. `--help` lists all nine sub-commands.
 * 3. `doctor --json` (without DISCORD_TOKEN) exits non-zero with parseable
 *    JSON that flags the missing token.
 *
 * Plan 12 Phase C.4: the original `describe.skipIf(!cliBuilt)` gate has
 * been removed. The vitest globalSetup hook in vitest.global-setup.ts
 * guarantees `dist/cli.js` exists before any test in this package runs,
 * so the gate is no longer required. Tests now run unconditionally on
 * fresh worktrees, in CI, and during local dev.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');

/** Run the built CLI and capture both stdout and exit code. */
function runCli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DISCORD_MCP_ACTIVITY: 'off', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
    };
    const decode = (v: string | Buffer | undefined): string =>
      v === undefined ? '' : typeof v === 'string' ? v : v.toString('utf8');
    return {
      stdout: decode(err.stdout),
      stderr: decode(err.stderr),
      status: err.status ?? null,
    };
  }
}

describe('cli binary smoke (post-build)', () => {
  it('--version prints package version', () => {
    const { stdout, stderr, status } = runCli(['--version']);
    const combined = stdout + stderr;
    expect(combined).toContain(packageJson.version);
    expect(status).toBe(0);
  });

  it('--help lists all nine subcommands', () => {
    const { stdout, stderr, status } = runCli(['--help']);
    const combined = stdout + stderr;
    expect(combined).toContain('serve');
    expect(combined).toContain('doctor');
    expect(combined).toContain('smoke');
    expect(combined).toContain('init');
    expect(combined).toContain('migrate');
    expect(combined).toMatch(/\n {2}setup \[options\]\s/);
    expect(combined).toMatch(/\n {2}profile\s/);
    expect(combined).toMatch(/\n {2}activity \[options\]\s/);
    expect(combined).toMatch(/\n {2}update \[options\]\s/);
    expect(status).toBe(0);
  });

  it('doctor --json without token exits non-zero with parseable JSON', () => {
    const { stdout, status } = runCli(['doctor', '--json']);
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; exitCode: number };
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(2);
  });

  it('records a filtered local result that the built activity command can read', () => {
    const appData = mkdtempSync(join(tmpdir(), 'discord-mcp-cli-activity-'));
    const env = { APPDATA: appData, XDG_CONFIG_HOME: appData, DISCORD_MCP_ACTIVITY: '' };
    try {
      const doctor = runCli(['doctor', '--json'], env);
      expect(doctor.status).toBe(2);

      const activity = runCli(['activity', '--json'], env);
      expect(activity.status).toBe(0);
      const summary = JSON.parse(activity.stdout) as {
        data: { total: number; recent: Array<{ command: string; outcome: string }> };
      };
      expect(summary.data.total).toBe(1);
      expect(summary.data.recent[0]).toMatchObject({ command: 'doctor', outcome: 'failure' });

      const journal = readFileSync(join(appData, 'discord-mcp', 'activity.jsonl'), 'utf8');
      expect(journal).not.toContain('DISCORD_TOKEN');
      expect(journal).not.toContain('Bot ');
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
