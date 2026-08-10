/**
 * `migrateAction` unit tests - Plan 9 Phase E.
 *
 * Drives the command directly (no commander). Captures stdout via a
 * vi.spyOn write hook so tests can assert pretty-mode strings and
 * parse JSON-mode payloads. Uses the synthetic Hubdustry fixture for
 * the happy-path "ran with unmapped" assertion.
 *
 * cwd is mutated for the "no --source" branch - restored in afterEach.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAction } from './migrate.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'hubdustry-go-mcp');

const originalExitCode = process.exitCode;
const originalCwd = process.cwd();

let stdoutWrites: string[] = [];

beforeEach(() => {
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  // Restore cwd in case a test changed it.
  if (process.cwd() !== originalCwd) {
    process.chdir(originalCwd);
  }
});

function stdoutOutput(): string {
  return stdoutWrites.join('');
}

interface AdapterSummary {
  id: string;
  description: string;
  homepage?: string;
  languages: string[];
  toolCountEstimate?: number;
}

interface MigrateJsonResult {
  ok: boolean;
  exitCode: number;
  summary: string;
  data?: {
    available?: { id: string; description: string }[] | string[];
    adapters?: AdapterSummary[];
    requested?: string;
    adapter?: string;
    sourcePath?: string;
    result?: {
      source: string;
      sourcePath: string;
      mappedTools: { original: string; mapped: string; confidence: string }[];
      unmappedTools: string[];
      manualReview: { original: string; reason: string }[];
      warnings: string[];
    };
  };
  errors?: string[];
}

describe('migrateAction - no --from', () => {
  it('exits 2 and lists available adapters in JSON', async () => {
    await migrateAction({ json: true });
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toContain('--from');
    const available = parsed.data?.available as { id: string; description: string }[];
    expect(Array.isArray(available)).toBe(true);
    expect(available.some((a) => a.id === 'hubdustry-go-mcp')).toBe(true);
  });

  it('pretty mode prints available adapter ids', async () => {
    await migrateAction({});
    expect(process.exitCode).toBe(2);
    const out = stdoutOutput();
    expect(out).toContain('Available adapters');
    expect(out).toContain('hubdustry-go-mcp');
  });
});

describe('migrateAction - unknown --from', () => {
  it('exits 2 with the requested id and the available list', async () => {
    await migrateAction({ json: true, from: 'no-such-adapter' });
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
    expect(parsed.summary).toContain('no-such-adapter');
    expect(parsed.data?.requested).toBe('no-such-adapter');
    expect(parsed.data?.available).toContain('hubdustry-go-mcp');
  });
});

describe('migrateAction - source not detected', () => {
  it('exits 2 when the source path has no Hubdustry markers', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'migrate-no-source-'));
    try {
      await migrateAction({ json: true, from: 'hubdustry-go-mcp', source: empty });
      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
      expect(parsed.summary).toContain('source not detected');
      expect(parsed.data?.adapter).toBe('hubdustry-go-mcp');
      expect(parsed.data?.sourcePath).toBe(empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('falls back to process.cwd() when --source is omitted', async () => {
    // Move cwd somewhere with no Hubdustry markers, run with no --source.
    // The result should mention that cwd as the sourcePath in the error.
    const empty = mkdtempSync(join(tmpdir(), 'migrate-cwd-'));
    process.chdir(empty);
    try {
      await migrateAction({ json: true, from: 'hubdustry-go-mcp' });
      expect(process.exitCode).toBe(2);
      const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
      expect(parsed.summary).toContain('source not detected');
    } finally {
      // afterEach restores cwd before rmSync would conflict.
      process.chdir(originalCwd);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('migrateAction - Hubdustry fixture run', () => {
  it('exits 1 (unmapped) and surfaces the 5 fixture tools', async () => {
    await migrateAction({ json: true, from: 'hubdustry-go-mcp', source: FIXTURE_ROOT });
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.summary).toContain('0/5 mapped');
    expect(parsed.summary).toContain('5 unmapped');
    const result = parsed.data?.result;
    expect(result?.unmappedTools.length).toBe(5);
    expect(result?.mappedTools.length).toBe(0);
    expect(result?.manualReview.length).toBe(0);
  });

  it('pretty mode lists the unmapped tool names under "Unmapped"', async () => {
    await migrateAction({ json: false, from: 'hubdustry-go-mcp', source: FIXTURE_ROOT });
    expect(process.exitCode).toBe(1);
    const out = stdoutOutput();
    expect(out).toContain('Unmapped (5)');
    expect(out).toContain('server.files.list');
    expect(out).toContain('server.deploy.trigger');
  });
});

describe('migrateAction - JSON output is parseable', () => {
  it('every code path produces valid JSON when --json is set', async () => {
    // Each branch parses cleanly.
    await migrateAction({ json: true });
    expect(() => JSON.parse(stdoutOutput())).not.toThrow();

    stdoutWrites = [];
    await migrateAction({ json: true, from: 'hubdustry-go-mcp', source: FIXTURE_ROOT });
    expect(() => JSON.parse(stdoutOutput())).not.toThrow();

    stdoutWrites = [];
    await migrateAction({ json: true, list: true });
    expect(() => JSON.parse(stdoutOutput())).not.toThrow();
  });
});

describe('migrateAction - --list flag (Plan 11 Phase A)', () => {
  it('TTY mode prints truthful metadata and omits unavailable Hubdustry claims', async () => {
    await migrateAction({ list: true });
    const out = stdoutOutput();
    expect(out).toContain('Available migration adapters');
    expect(out).toContain('hubdustry-go-mcp');
    expect(out).toContain('Hubdustry-shaped Go MCP fixture');
    expect(out).toContain('Languages: go');
    expect(out).not.toContain('Tools: ~8');
    expect(out).not.toContain('https://github.com/jhm1909/Hubdustry');
    expect(out).toContain('Use: discord-mcp migrate --from <id>');
  });

  it('--list --json omits unverifiable upstream metadata for the Hubdustry fixture', async () => {
    await migrateAction({ list: true, json: true });
    const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    const adapters = parsed.data?.adapters;
    expect(Array.isArray(adapters)).toBe(true);
    expect(adapters?.length).toBeGreaterThanOrEqual(1);
    const hubdustry = adapters?.find((a) => a.id === 'hubdustry-go-mcp');
    expect(hubdustry).toBeDefined();
    expect(hubdustry?.description).toContain('Hubdustry');
    expect(hubdustry?.languages).toEqual(['go']);
    expect(hubdustry?.toolCountEstimate).toBeUndefined();
    expect(hubdustry?.homepage).toBeUndefined();
  });

  it('--list exits with code 0 (informational query, not an error)', async () => {
    await migrateAction({ list: true });
    expect(process.exitCode).toBe(0);

    // Same for the JSON path.
    stdoutWrites = [];
    process.exitCode = 0;
    await migrateAction({ list: true, json: true });
    expect(process.exitCode).toBe(0);
  });

  it('no --from AND no --list still exits 2 (Plan 9 backward compat)', async () => {
    // Plan 11 leaves the legacy "missing --from" error path alone so
    // existing scripts that depend on the non-zero exit don't break.
    // The bare invocation must keep exit code 2 even though `--list`
    // produces the same listing under exit 0.
    await migrateAction({ json: true });
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutOutput()) as MigrateJsonResult;
    expect(parsed.summary).toContain('--from');
    // Plan 11 enriches data with `adapters` so --json consumers still
    // get the new metadata even on this legacy path.
    expect(parsed.data?.adapters).toBeDefined();
    expect(parsed.data?.adapters?.[0]?.id).toBe('hubdustry-go-mcp');
  });
});
