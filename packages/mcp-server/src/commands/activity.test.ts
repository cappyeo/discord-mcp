import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordActivity, resolveActivityPath } from '../lib/activity.js';
import { activityAction } from './activity.js';

const originalExitCode = process.exitCode;
const originalAppData = process.env.APPDATA;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let root: string;
let stdoutWrites: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'discord-mcp-activity-command-'));
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.exitCode = 0;
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  process.exitCode = originalExitCode;
});

describe('activityAction', () => {
  it('reports the local evidence summary without recording itself', () => {
    recordActivity({
      version: 1,
      at: '2026-08-03T00:00:00.000Z',
      command: 'setup',
      outcome: 'success',
      signals: ['profile-config-generated'],
    });

    activityAction({ json: true });

    const result = JSON.parse(stdoutWrites.join(''));
    expect(result).toMatchObject({
      ok: true,
      data: { total: 1, commands: { setup: { success: 1 } } },
    });
  });

  it('returns an explicit report handoff without network access or journal writes', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    activityAction({ json: true, report: true });

    const result = JSON.parse(stdoutWrites.join(''));
    expect(result).toMatchObject({
      ok: true,
      data: {
        submitted: false,
        network_accessed: false,
        report_url:
          'https://github.com/cappyeo/discord-mcp/issues/new?template=verified-outcome.yml',
      },
    });
    expect(result.data).not.toHaveProperty('prefill');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(resolveActivityPath())).toBe(false);
  });
});
