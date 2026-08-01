import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock startStdio so `serve` is a no-op. Hoisted before cli.ts loads.
vi.mock('./transports/stdio.js', () => ({
  startStdio: vi.fn(async () => {
    // No-op: real startStdio would block on the MCP transport.
  }),
}));

// Now import cli - its top-level auto-parse is gated behind VITEST=true.
const { buildProgram } = await import('./cli.js');
const { startStdio } = await import('./transports/stdio.js');

import packageJson from '../package.json' with { type: 'json' };

const originalGateway = process.env.GATEWAY;
const originalExitCode = process.exitCode;

let stdoutWrites: string[] = [];
// Commander keeps parsed option values on the Command instance forever, so
// a shared program leaks flags (e.g. doctor --json) into later tests. Build
// a fresh tree per test instead.
let program: Command;

beforeEach(() => {
  program = buildProgram();
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  delete process.env.GATEWAY;
  process.exitCode = 0;
  vi.mocked(startStdio).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGateway !== undefined) {
    process.env.GATEWAY = originalGateway;
  } else {
    delete process.env.GATEWAY;
  }
  process.exitCode = originalExitCode;
});

function stdoutOutput(): string {
  return stdoutWrites.join('');
}

/**
 * Drive commander.parseAsync with synthetic argv. We override commander's
 * default exit/output behavior so version/help don't terminate the test
 * process and so we can capture their output via our stdout spy.
 */
async function runCli(args: string[]): Promise<void> {
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => {
      stdoutWrites.push(str);
    },
    writeErr: (str) => {
      stdoutWrites.push(str);
    },
  });
  // Sub-commands keep their own exit/output config - propagate to all of
  // them so `discord-mcp init --help` doesn't call process.exit() directly.
  for (const sub of program.commands) {
    sub.exitOverride();
    sub.configureOutput({
      writeOut: (str) => {
        stdoutWrites.push(str);
      },
      writeErr: (str) => {
        stdoutWrites.push(str);
      },
    });
  }
  try {
    await program.parseAsync(['node', 'cli.js', ...args]);
  } catch (e) {
    // commander.exitOverride() throws CommanderError for --version / --help
    // and unknown commands. Re-throw only if it's not one of those terminal
    // codes so tests can still see real failures.
    const code = (e as { code?: string } | undefined)?.code;
    if (
      code !== 'commander.version' &&
      code !== 'commander.helpDisplayed' &&
      code !== 'commander.help'
    ) {
      throw e;
    }
  }
}

describe('cli - version + help', () => {
  it('--version prints package version', async () => {
    await runCli(['--version']);
    expect(stdoutOutput()).toContain(packageJson.version);
  });

  it('--help lists all sub-commands', async () => {
    await runCli(['--help']);
    const out = stdoutOutput();
    expect(out).toContain('serve');
    expect(out).toContain('doctor');
    expect(out).toContain('init');
    expect(out).toContain('migrate');
  });
});

describe('cli - serve (default sub-command)', () => {
  it('bare invocation routes to serve', async () => {
    await runCli([]);
    expect(startStdio).toHaveBeenCalledTimes(1);
    expect(process.env.GATEWAY).toBeUndefined();
  });

  it('explicit `serve` sub-command works', async () => {
    await runCli(['serve']);
    expect(startStdio).toHaveBeenCalledTimes(1);
  });

  it('serve --gateway sets GATEWAY=1', async () => {
    await runCli(['serve', '--gateway']);
    expect(process.env.GATEWAY).toBe('1');
    expect(startStdio).toHaveBeenCalledTimes(1);
  });
});

describe('cli - doctor sub-command (Plan 9 Phase B)', () => {
  // Without DISCORD_TOKEN env, env-vars + token-format checks fail → exit 2.
  // We deliberately rely on the test runner's real env (no token) to get a
  // deterministic fail; if a developer has DISCORD_TOKEN exported in their
  // shell, vitest inherits it and the result would be exit 0 or 1 here. We
  // strip it explicitly inside the test to prevent that.
  const savedDiscordToken = process.env.DISCORD_TOKEN;
  beforeEach(() => {
    delete process.env.DISCORD_TOKEN;
  });
  afterEach(() => {
    if (savedDiscordToken !== undefined) {
      process.env.DISCORD_TOKEN = savedDiscordToken;
    } else {
      delete process.env.DISCORD_TOKEN;
    }
  });

  it('doctor exits with code 2 when token is missing', async () => {
    await runCli(['doctor']);
    expect(process.exitCode).toBe(2);
    // Pretty output mentions the failing checks by id.
    expect(stdoutOutput()).toContain('token-format');
    expect(stdoutOutput()).toContain('env-vars');
  });

  it('doctor accepts --json and emits parseable JSON', async () => {
    await runCli(['doctor', '--json']);
    expect(process.exitCode).toBe(2);
    const out = stdoutOutput();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.data?.checks).toBeDefined();
    expect(Array.isArray(parsed.data.checks)).toBe(true);
  });

  it('doctor accepts --online without breaking option shape', async () => {
    // Phase B: --online filters checks but no online checks exist yet, so
    // running with --online still produces the same offline check set
    // (offline checks have online: false; --online just lifts the filter).
    await runCli(['doctor', '--online']);
    expect(process.exitCode).toBe(2);
    // --online alone must take the PRETTY path. With a shared program this
    // asserted nothing: the previous `doctor --json` case left json: true on
    // the sub-command and the output was still JSON.
    const out = stdoutOutput();
    expect(out).toContain('token-format');
    expect(() => JSON.parse(out)).toThrow();
  });
});

describe('cli - init sub-command (Plan 9 Phase D)', () => {
  // Force non-interactive so init takes the deterministic flag-only path.
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinTTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutTTY,
      configurable: true,
      writable: true,
    });
  });

  it('init --help lists all the new flags', async () => {
    await runCli(['init', '--help']);
    const out = stdoutOutput();
    expect(out).toContain('--client');
    expect(out).toContain('--token');
    expect(out).toContain('--gateway');
    expect(out).toContain('--output');
    expect(out).toContain('--force');
    expect(out).toContain('--json');
  });

  it('init --json --client generic produces parseable JSON with exit code 0', async () => {
    await runCli(['init', '--json', '--client', 'generic']);
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutOutput()) as { ok: boolean; data?: { client?: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.client).toBe('generic');
  });

  it('init --client unknown-client exits with code 2', async () => {
    await runCli(['init', '--json', '--client', 'unknown-client']);
    expect(process.exitCode).toBe(2);
  });
});

describe('cli - migrate sub-command (Plan 9 Phase E)', () => {
  it('migrate without --from exits 2 and lists available adapters', async () => {
    await runCli(['migrate']);
    expect(process.exitCode).toBe(2);
    const out = stdoutOutput();
    expect(out).toContain('--from');
    expect(out).toContain('hubdustry-go-mcp');
  });

  it('migrate --help lists --from / --source / --list / --json', async () => {
    await runCli(['migrate', '--help']);
    const out = stdoutOutput();
    expect(out).toContain('--from');
    expect(out).toContain('--source');
    expect(out).toContain('--list');
    expect(out).toContain('--json');
  });
});

describe('cli - migrate --list (Plan 11 Phase A)', () => {
  it('migrate --list --help shows the --list flag', async () => {
    await runCli(['migrate', '--list', '--help']);
    const out = stdoutOutput();
    expect(out).toContain('--list');
    expect(out).toContain('List all available adapters');
  });

  it('migrate --list exits 0 and prints the adapter listing', async () => {
    await runCli(['migrate', '--list']);
    expect(process.exitCode).toBe(0);
    const out = stdoutOutput();
    expect(out).toContain('Available migration adapters');
    expect(out).toContain('hubdustry-go-mcp');
  });
});
