import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_RETENTION,
  captureActivity,
  readActivity,
  recordActivity,
  recordBlueprintActivity,
  resolveActivityPath,
  summarizeActivity,
} from './activity.js';
import { emitResult } from './output.js';

let directory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
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

  it('records template lifecycle evidence without a guild ID or template code', async () => {
    const options = location();
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await captureActivity(
        { command: 'smoke', confirmWrite: true, confirmTemplateLifecycle: true, ...options },
        async () => {
          emitResult(
            {
              ok: true,
              exitCode: 0,
              summary: 'MCP write smoke passed; temporary artifacts were removed',
              data: {
                cleanupComplete: true,
                steps: {
                  identityRead: true,
                  guildsRead: true,
                  templateCreated: true,
                  templateDriftObserved: true,
                  templateSynced: true,
                },
                guildId: '123456789012345678',
                templateCode: 'must-not-be-recorded',
              },
            },
            true,
          );
        },
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(readActivity(options)[0]).toMatchObject({
      command: 'smoke',
      outcome: 'success',
      signals: [
        'write-confirmed',
        'template-lifecycle-confirmed',
        'identity-read',
        'guilds-read',
        'template-created',
        'template-drift-observed',
        'template-synced',
        'cleanup-complete',
      ],
    });
    const raw = readFileSync(resolveActivityPath(options), 'utf8');
    expect(raw).not.toContain('123456789012345678');
    expect(raw).not.toContain('must-not-be-recorded');
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

  it('does not read or write through a symlinked activity journal', ({ skip }) => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    const externalPath = join(directory as string, 'external.jsonl');
    const externalEvent = `${JSON.stringify({
      version: 1,
      at: '2026-08-30T00:00:00.000Z',
      command: 'setup',
      outcome: 'success',
      signals: ['external-sentinel'],
    })}\n`;
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(externalPath, externalEvent);
    try {
      symlinkSync(externalPath, activityPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }

    expect(readActivity(options)).toEqual([]);
    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'failure',
        signals: ['must-not-be-written'],
      },
      options,
    );

    expect(lstatSync(activityPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath, 'utf8')).toBe(externalEvent);
  });

  it('does not read or write through a symlinked activity directory', ({ skip }) => {
    location();
    const externalDirectory = join(directory as string, 'external-activity');
    const linkedDirectory = join(directory as string, 'linked-activity');
    const options = { directory: join(linkedDirectory, 'profiles') };
    const externalPath = join(externalDirectory, 'activity.jsonl');
    mkdirSync(externalDirectory);
    writeFileSync(
      externalPath,
      `${JSON.stringify({
        version: 1,
        at: '2026-08-30T00:00:00.000Z',
        command: 'setup',
        outcome: 'success',
        signals: ['external-sentinel'],
      })}\n`,
    );
    try {
      symlinkSync(externalDirectory, linkedDirectory, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }

    expect(readActivity(options)).toEqual([]);
    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'failure',
        signals: ['must-not-be-written'],
      },
      options,
    );

    expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(true);
    expect(readFileSync(externalPath, 'utf8')).not.toContain('must-not-be-written');
  });

  it('skips a concurrent writer while preserving its live lock', () => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    const lockPath = join(dirname(activityPath), '.activity.lock');
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(lockPath, 'other-process\n');

    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'success',
        signals: [],
      },
      options,
    );

    expect(readActivity(options)).toEqual([]);
    expect(readFileSync(lockPath, 'utf8')).toBe('other-process\n');
  });

  it('reclaims an unchanged stale lock before recording', () => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    const lockPath = join(dirname(activityPath), '.activity.lock');
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(lockPath, '424242\n');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
    });

    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'success',
        signals: [],
      },
      options,
    );

    expect(readActivity(options)).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim an old lock while its owner is still alive', () => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    const lockPath = join(dirname(activityPath), '.activity.lock');
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n`);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'success',
        signals: [],
      },
      options,
    );

    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(readActivity(options)).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('does not read or reclaim an oversized stale lock', () => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    const lockPath = join(dirname(activityPath), '.activity.lock');
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(lockPath, Buffer.alloc(64, 0x31));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const kill = vi.spyOn(process, 'kill');

    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'success',
        signals: [],
      },
      options,
    );

    expect(kill).not.toHaveBeenCalled();
    expect(readActivity(options)).toEqual([]);
    expect(statSync(lockPath).size).toBe(64);
  });

  it('does not append beyond the bounded journal size', () => {
    const options = location();
    const activityPath = resolveActivityPath(options);
    mkdirSync(dirname(activityPath), { recursive: true });
    writeFileSync(activityPath, Buffer.alloc(1024 * 1024 + 1, 0x78));
    const before = statSync(activityPath).size;

    recordActivity(
      {
        version: 1,
        at: '2026-08-30T01:00:00.000Z',
        command: 'doctor',
        outcome: 'success',
        signals: [],
      },
      options,
    );

    expect(statSync(activityPath).size).toBe(before);
    expect(readActivity(options)).toEqual([]);
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

  it('records a coarse blueprint v2 event without accepting raw data', () => {
    const options = location();
    recordBlueprintActivity(
      {
        stage: 'evidence',
        status: 'verified',
        outcome: 'success',
        transport: 'stdio',
      },
      options,
    );

    expect(readActivity(options)).toEqual([
      expect.objectContaining({
        version: 2,
        kind: 'blueprint',
        stage: 'evidence',
        status: 'verified',
        outcome: 'success',
        transport: 'stdio',
      }),
    ]);
    expect(readFileSync(resolveActivityPath(options), 'utf8')).not.toContain('guild');
  });

  it('keeps parsing legacy v1 events and summarizes blueprint counts by verified day', () => {
    const options = location();
    mkdirSync(dirname(resolveActivityPath(options)), { recursive: true });
    writeFileSync(
      resolveActivityPath(options),
      `${[
        JSON.stringify({
          version: 1,
          at: '2026-08-03T00:00:00.000Z',
          command: 'setup',
          outcome: 'success',
          signals: [],
        }),
        JSON.stringify({
          version: 2,
          kind: 'blueprint',
          at: '2026-08-04T00:00:00.000Z',
          stage: 'plan',
          status: 'ready',
          outcome: 'success',
          transport: 'stdio',
        }),
        JSON.stringify({
          version: 2,
          kind: 'blueprint',
          at: '2026-08-04T01:00:00.000Z',
          stage: 'evidence',
          status: 'verified',
          outcome: 'success',
          transport: 'http',
        }),
        '{malformed',
      ].join('\n')}\n`,
    );

    const summary = summarizeActivity(readActivity(options));
    expect(summary.total).toBe(3);
    expect(summary.blueprint).toMatchObject({
      total: 2,
      stages: { plan: 1, apply: 0, evidence: 1 },
      verifiedDays: 1,
    });
  });

  it('honors the caller opt-out for blueprint activity', () => {
    const options = location();
    const previous = process.env.DISCORD_MCP_ACTIVITY;
    process.env.DISCORD_MCP_ACTIVITY = 'off';
    try {
      recordBlueprintActivity(
        { stage: 'plan', status: 'ready', outcome: 'success', transport: 'stdio' },
        options,
      );
    } finally {
      if (previous === undefined) delete process.env.DISCORD_MCP_ACTIVITY;
      else process.env.DISCORD_MCP_ACTIVITY = previous;
    }
    expect(readActivity(options)).toEqual([]);
  });

  it('rejects a runtime observation outside the coarse enum allowlist', () => {
    const options = location();
    recordBlueprintActivity(
      {
        stage: 'evidence',
        status: 'verified:123456789012345678',
        outcome: 'success',
        transport: 'stdio',
      } as never,
      options,
    );

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
    expect(summary.recent[0]).toMatchObject({ command: 'smoke' });
  });
});
