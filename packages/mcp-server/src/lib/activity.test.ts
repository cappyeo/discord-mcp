import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_RETENTION,
  captureActivity,
  readActivity,
  recordActivity,
  resolveActivityPath,
  summarizeActivity,
} from './activity.js';
import { emitResult } from './output.js';

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function location(): { directory: string } {
  directory = mkdtempSync(join(tmpdir(), 'discord-mcp-activity-'));
  return { directory: join(directory, 'profiles') };
}

describe('activity evidence', () => {
  it('records only a filtered command result in a local JSONL journal', async () => {
    const options = location();
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await captureActivity({ command: 'doctor', online: true, ...options }, async () => {
        emitResult(
          {
            ok: false,
            exitCode: 2,
            summary: '7 checks: 1 fail, 0 warn, 6 ok',
            errors: ['DISCORD_TOKEN=Bot.secret-must-not-be-recorded'],
            data: { checks: [{ id: 'token-online', status: 'fail', details: { id: '123' } }] },
          },
          true,
        );
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const events = readActivity(options);
    expect(events).toEqual([
      expect.objectContaining({
        command: 'doctor',
        outcome: 'failure',
        signals: ['online', 'check:token-online:fail'],
      }),
    ]);
    const raw = readFileSync(resolveActivityPath(options), 'utf8');
    expect(raw).not.toContain('secret-must-not-be-recorded');
    expect(raw).not.toContain('"123"');
  });

  it('records an Administrator setup warning without the Discord identity', async () => {
    const options = location();
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await captureActivity({ command: 'setup', ...options }, async () => {
        emitResult(
          {
            ok: false,
            exitCode: 1,
            summary: 'generated Codex config',
            warnings: ['Bot has Administrator in Test Guild (123456789012345678).'],
          },
          true,
        );
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(readActivity(options)[0]).toMatchObject({
      command: 'setup',
      outcome: 'warning',
      signals: ['profile-config-generated', 'administrator-warning'],
    });
    const raw = readFileSync(resolveActivityPath(options), 'utf8');
    expect(raw).not.toContain('Test Guild');
    expect(raw).not.toContain('123456789012345678');
  });

  it('keeps the journal bounded to the latest records', () => {
    const options = location();
    for (let index = 0; index <= ACTIVITY_RETENTION; index += 1) {
      recordActivity(
        {
          version: 1,
          at: new Date(1_700_000_000_000 + index).toISOString(),
          command: 'setup',
          outcome: 'success',
          signals: ['profile-config-generated'],
        },
        options,
      );
    }
    const events = readActivity(options);
    expect(events).toHaveLength(ACTIVITY_RETENTION);
    expect(events[0]?.at).toBe(new Date(1_700_000_000_001).toISOString());
  });

  it('uses XDG_CONFIG_HOME for the Linux journal location', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'discord-mcp-activity-xdg-'));
    directory = configRoot;
    expect(
      resolveActivityPath({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: configRoot },
        homeDirectory: configRoot,
      }),
    ).toBe(join(configRoot, 'discord-mcp', 'activity.jsonl'));
  });

  it('honors the caller opt-out without changing the command action', async () => {
    const options = location();
    const previous = process.env.DISCORD_MCP_ACTIVITY;
    process.env.DISCORD_MCP_ACTIVITY = 'off';
    try {
      await captureActivity({ command: 'setup', ...options }, async () => undefined);
    } finally {
      if (previous === undefined) delete process.env.DISCORD_MCP_ACTIVITY;
      else process.env.DISCORD_MCP_ACTIVITY = previous;
    }
    expect(readActivity(options)).toEqual([]);
  });

  it('summarizes outcomes and returns the newest events first', () => {
    const summary = summarizeActivity([
      {
        version: 1,
        at: '2026-08-03T00:00:00.000Z',
        command: 'setup',
        outcome: 'success',
        signals: [],
      },
      {
        version: 1,
        at: '2026-08-03T00:01:00.000Z',
        command: 'smoke',
        outcome: 'failure',
        signals: [],
      },
    ]);
    expect(summary.commands.setup.success).toBe(1);
    expect(summary.commands.smoke.failure).toBe(1);
    expect(summary.recent[0]?.command).toBe('smoke');
  });
});
