/**
 * Integration-ish tests for `doctorAction` - Plan 9 Phase B.
 *
 * Covers the doctor command's aggregation logic, exit code mapping,
 * and JSON / pretty-mode output. Per-check unit tests live alongside
 * each check under `lib/checks/*.test.ts`. We mock `fs.accessSync`
 * here only for the audit-sink scenarios - everything else uses real
 * env-var manipulation against the real check implementations.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProfile } from '../lib/profiles.js';

// Mock node:fs at module-eval time so audit-sink (file branch) can be
// driven deterministically. Default impl is a no-op (writable). Tests
// that need a failing access rebind `accessSyncImpl` before calling.
let accessSyncImpl: (...args: unknown[]) => void = () => undefined;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    accessSync: ((...args: unknown[]) => accessSyncImpl(...args)) as typeof actual.accessSync,
  };
});

const { doctorAction } = await import('./doctor.js');

// Default fetch mock: any --online test that exercises the online checks
// without explicitly stubbing fetch will see a network warn - fine for
// the ID-set assertions that don't care about per-check status.
const DEFAULT_FETCH_MOCK = () => vi.fn().mockResolvedValue(new Response('', { status: 500 }));

const VALID_TOKEN = `Bot ${'a'.repeat(60)}`;

const originalToken = process.env.DISCORD_TOKEN;
const originalAuditSink = process.env.MCP_AUDIT_SINK;
const originalAuditFile = process.env.MCP_AUDIT_FILE;
const originalCodexHome = process.env.CODEX_HOME;
const originalExpectedBotId = process.env.DISCORD_EXPECTED_BOT_ID;
const originalAllowedGuilds = process.env.ALLOWED_GUILDS;
const originalToolSurface = process.env.MCP_TOOL_SURFACE;
const originalGateway = process.env.GATEWAY;
const originalIsTTY = process.stdout.isTTY;
const originalExitCode = process.exitCode;

let stdoutWrites: string[] = [];

beforeEach(() => {
  accessSyncImpl = () => undefined;
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  delete process.env.DISCORD_TOKEN;
  delete process.env.MCP_AUDIT_SINK;
  delete process.env.MCP_AUDIT_FILE;
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  accessSyncImpl = () => undefined;
  if (originalToken !== undefined) {
    process.env.DISCORD_TOKEN = originalToken;
  } else {
    delete process.env.DISCORD_TOKEN;
  }
  if (originalAuditSink !== undefined) {
    process.env.MCP_AUDIT_SINK = originalAuditSink;
  } else {
    delete process.env.MCP_AUDIT_SINK;
  }
  if (originalAuditFile !== undefined) {
    process.env.MCP_AUDIT_FILE = originalAuditFile;
  } else {
    delete process.env.MCP_AUDIT_FILE;
  }
  if (originalCodexHome !== undefined) {
    process.env.CODEX_HOME = originalCodexHome;
  } else {
    delete process.env.CODEX_HOME;
  }
  if (originalExpectedBotId !== undefined) {
    process.env.DISCORD_EXPECTED_BOT_ID = originalExpectedBotId;
  } else {
    delete process.env.DISCORD_EXPECTED_BOT_ID;
  }
  if (originalAllowedGuilds !== undefined) {
    process.env.ALLOWED_GUILDS = originalAllowedGuilds;
  } else {
    delete process.env.ALLOWED_GUILDS;
  }
  if (originalToolSurface !== undefined) {
    process.env.MCP_TOOL_SURFACE = originalToolSurface;
  } else {
    delete process.env.MCP_TOOL_SURFACE;
  }
  if (originalGateway !== undefined) {
    process.env.GATEWAY = originalGateway;
  } else {
    delete process.env.GATEWAY;
  }
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
    writable: true,
  });
  process.exitCode = originalExitCode;
});

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}

function stdoutOutput(): string {
  return stdoutWrites.join('');
}

function createCodexProfileFixture(version = '0.14.6'): {
  directory: string;
  profileDirectory: string;
  configPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-doctor-update-'));
  const profileDirectory = join(directory, 'profiles');
  const codexHome = join(directory, 'codex');
  const configPath = join(codexHome, 'config.toml');
  mkdirSync(codexHome, { recursive: true });
  saveProfile(
    {
      version: 1,
      name: 'devbot',
      bot: { id: '123456789012345678', username: 'doctor-update-bot' },
      credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
      allowedGuilds: ['987654321098765432'],
      client: 'codex',
      toolSurface: 'progressive',
      gateway: false,
    },
    { directory: profileDirectory },
  );
  writeFileSync(
    configPath,
    [
      '[mcp_servers.discord-mcp]',
      'command = "npx"',
      `args = ["--yes", "--loglevel=error", "@discord-mcp/cli@${version}", "serve", "--profile", "devbot"]`,
      'env_vars = ["DISCORD_TOKEN"]',
      '',
    ].join('\n'),
  );
  process.env.CODEX_HOME = codexHome;
  return { directory, profileDirectory, configPath };
}

function onlineDoctorFetch(latestVersion: string | undefined): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('registry.npmjs.org')) {
      return latestVersion === undefined
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ 'dist-tags': { latest: latestVersion } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }
    return new Response(JSON.stringify({ id: '123456789012345678', username: 'bot', bot: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('doctor profile activation', () => {
  it('reports a missing profile without running the check suite', async () => {
    await doctorAction({
      json: true,
      profile: 'missing',
      profileDirectory: join(tmpdir(), `discord-mcp-missing-doctor-${process.pid}`),
    });

    const parsed = JSON.parse(stdoutOutput());
    expect(process.exitCode).toBe(2);
    expect(parsed.summary).toContain('could not activate profile');
    expect(parsed.errors[0]).toContain('Profile not found');
    expect(parsed.data).toBeUndefined();
  });
});

/**
 * Drain helper (Plan 12 Phase C.2). Mirrors the pattern in
 * doctor.integration.test.ts: await doctorAction, yield to setImmediate so
 * pending microtasks flush, then read the captured stdout. Eliminates a
 * documented JSON.parse race under parallel CPU pressure.
 */
async function runAndCapture(fn: () => Promise<void>): Promise<string> {
  await fn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return stdoutOutput();
}

// CSI byte = ESC + '['. Avoid embedded control bytes in regex per
// biome's noControlCharactersInRegex (mirrors output.test.ts).
const CSI_BYTE = '\x1b[';
function hasAnsi(s: string): boolean {
  return s.includes(CSI_BYTE);
}

describe('doctorAction - online check selection', () => {
  it('runs only the 5 offline checks when --online is absent', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const fetchMock = DEFAULT_FETCH_MOCK();
    vi.stubGlobal('fetch', fetchMock);
    const out = await runAndCapture(() => doctorAction({ json: true }));
    const parsed = JSON.parse(out) as {
      data?: { checks?: Array<{ id: string }> };
    };
    const ids = parsed.data?.checks?.map((c) => c.id) ?? [];
    expect(ids).toEqual(['node-version', 'token-format', 'env-vars', 'audit-sink', 'client-caps']);
    // CRITICAL: --online not passed → online checks must NOT call fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs all 7 checks (5 offline + 2 online) when --online is true', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    // OTEL_ENABLED defaults to false → otel-reachable skips its fetch.
    // token-online still calls fetch - return a 200 so the test reports ok.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1', username: 'bot', bot: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await runAndCapture(() => doctorAction({ json: true, online: true }));
    const parsed = JSON.parse(out) as {
      data?: { checks?: Array<{ id: string }> };
    };
    const ids = parsed.data?.checks?.map((c) => c.id) ?? [];
    expect(ids).toEqual([
      'node-version',
      'token-format',
      'env-vars',
      'audit-sink',
      'client-caps',
      'token-online',
      'otel-reachable',
    ]);
    // token-online hit the network exactly once. otel-reachable did NOT
    // because OTEL_ENABLED=false → skips request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('doctorAction - Codex launcher update discovery', () => {
  it('warns about a newer generated launcher without changing the config', async () => {
    const fixture = createCodexProfileFixture();
    try {
      process.env.DISCORD_TOKEN = VALID_TOKEN;
      const before = readFileSync(fixture.configPath, 'utf8');
      vi.stubGlobal('fetch', onlineDoctorFetch('0.14.7'));

      const out = await runAndCapture(() =>
        doctorAction({
          json: true,
          online: true,
          profile: 'devbot',
          profileDirectory: fixture.profileDirectory,
        }),
      );

      const parsed = JSON.parse(out) as {
        exitCode: number;
        data: { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> };
      };
      const updateCheck = parsed.data.checks.find((check) => check.id === 'codex-launcher-update');
      expect(parsed.exitCode).toBe(1);
      expect(updateCheck).toMatchObject({
        status: 'warn',
        details: { currentVersion: '0.14.6', targetVersion: '0.14.7', updateAvailable: true },
      });
      expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('keeps a custom launcher caller-managed without checking npm', async () => {
    const fixture = createCodexProfileFixture();
    try {
      process.env.DISCORD_TOKEN = VALID_TOKEN;
      writeFileSync(
        fixture.configPath,
        [
          '[mcp_servers.discord-mcp]',
          'command = "powershell.exe"',
          'args = ["-Command", "npx --yes @discord-mcp/cli@0.14.6 serve --profile devbot"]',
          '',
        ].join('\n'),
      );
      const fetchMock = onlineDoctorFetch('0.14.7');
      vi.stubGlobal('fetch', fetchMock);

      const out = await runAndCapture(() =>
        doctorAction({
          json: true,
          online: true,
          profile: 'devbot',
          profileDirectory: fixture.profileDirectory,
        }),
      );

      const parsed = JSON.parse(out) as {
        exitCode: number;
        data: { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> };
      };
      const updateCheck = parsed.data.checks.find((check) => check.id === 'codex-launcher-update');
      expect(parsed.exitCode).toBe(0);
      expect(updateCheck).toMatchObject({ status: 'ok', details: { managed: false } });
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('registry.npmjs.org')),
      ).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('warns when npm update discovery is unavailable without changing the config', async () => {
    const fixture = createCodexProfileFixture();
    try {
      process.env.DISCORD_TOKEN = VALID_TOKEN;
      const before = readFileSync(fixture.configPath, 'utf8');
      vi.stubGlobal('fetch', onlineDoctorFetch(undefined));

      const out = await runAndCapture(() =>
        doctorAction({
          json: true,
          online: true,
          profile: 'devbot',
          profileDirectory: fixture.profileDirectory,
        }),
      );

      const parsed = JSON.parse(out) as {
        exitCode: number;
        data: { checks: Array<{ id: string; status: string; details?: Record<string, unknown> }> };
      };
      const updateCheck = parsed.data.checks.find((check) => check.id === 'codex-launcher-update');
      expect(parsed.exitCode).toBe(1);
      expect(updateCheck).toMatchObject({ status: 'warn', details: { updateAvailable: null } });
      expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});

describe('doctorAction - exit code mapping', () => {
  it('returns exit code 2 when token-format fails', async () => {
    // No DISCORD_TOKEN → token-format + env-vars both fail.
    const out = await runAndCapture(() => doctorAction({ json: true }));
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    const tokenCheck = (parsed.data.checks as Array<{ id: string; status: string }>).find(
      (c) => c.id === 'token-format',
    );
    expect(tokenCheck?.status).toBe('fail');
  });

  it('returns exit code 1 (warn) when only token-format warns and rest are ok', async () => {
    // Valid shape but no "Bot " prefix → token-format warn.
    process.env.DISCORD_TOKEN = 'a'.repeat(60);
    const out = await runAndCapture(() => doctorAction({ json: true }));
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('returns exit code 0 when all checks pass', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const out = await runAndCapture(() => doctorAction({ json: true }));
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
  });
});

describe('doctorAction - audit-sink branches', () => {
  it('reports audit-sink ok when stderr sink is selected', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    process.env.MCP_AUDIT_SINK = 'stderr';
    const out = await runAndCapture(() => doctorAction({ json: true }));
    const parsed = JSON.parse(out);
    const auditCheck = (parsed.data.checks as Array<{ id: string; status: string }>).find(
      (c) => c.id === 'audit-sink',
    );
    expect(auditCheck?.status).toBe('ok');
  });

  it('reports audit-sink fail when file sink is unwritable', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    process.env.MCP_AUDIT_SINK = 'file';
    process.env.MCP_AUDIT_FILE = '/nonexistent/no-perms/audit.jsonl';
    accessSyncImpl = () => {
      throw new Error('EACCES: permission denied');
    };
    const out = await runAndCapture(() => doctorAction({ json: true }));
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(out);
    const auditCheck = (parsed.data.checks as Array<{ id: string; status: string }>).find(
      (c) => c.id === 'audit-sink',
    );
    expect(auditCheck?.status).toBe('fail');
  });
});

describe('doctorAction - output formatting', () => {
  it('pretty mode includes ANSI color codes when stdout is a TTY', async () => {
    setTTY(true);
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const out = await runAndCapture(() => doctorAction({ json: false }));
    expect(hasAnsi(out)).toBe(true);
    expect(out).toContain('OK');
  });

  it('pretty mode without TTY omits ANSI codes', async () => {
    setTTY(false);
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const out = await runAndCapture(() => doctorAction({ json: false }));
    expect(hasAnsi(out)).toBe(false);
  });

  it('json mode strips ANSI even on TTY and produces parseable output', async () => {
    setTTY(true);
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const out = await runAndCapture(() => doctorAction({ json: true }));
    expect(hasAnsi(out)).toBe(false);
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.summary).toMatch(/\d+ checks:/);
  });

  it('summary string follows the "N checks: F fail, W warn, O ok" format (offline-only)', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    const out = await runAndCapture(() => doctorAction({ json: true }));
    const parsed = JSON.parse(out);
    // 5 offline checks when --online is absent.
    expect(parsed.summary).toMatch(/^5 checks: \d+ fail, \d+ warn, \d+ ok$/);
  });

  it('summary reports 7 checks when --online is true', async () => {
    process.env.DISCORD_TOKEN = VALID_TOKEN;
    vi.stubGlobal('fetch', DEFAULT_FETCH_MOCK());
    const out = await runAndCapture(() => doctorAction({ json: true, online: true }));
    const parsed = JSON.parse(out);
    expect(parsed.summary).toMatch(/^7 checks: \d+ fail, \d+ warn, \d+ ok$/);
  });
});
