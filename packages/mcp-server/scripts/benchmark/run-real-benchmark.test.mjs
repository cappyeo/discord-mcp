import { describe, expect, it } from 'vitest';

import {
  assertBenchmarkNotBefore,
  attachApplyResultLossInjection,
  benchmarkProcessExitCode,
  main,
  parseBenchmarkCommand,
  publishCampaignAttestation,
  releaseCampaignLock,
} from './run-real-benchmark.mjs';

const COMMIT = 'babe8518767270733e5442643690cac13f94e473';
const NOT_BEFORE = '2026-08-14T04:03:25.930+09:00';
const OWNER_PID = '999999999';
const OWNER_HOSTNAME = 'benchmark-host';

function runArgs(...extra) {
  return [
    'run',
    '--expected-commit',
    COMMIT,
    '--artifact-root',
    'C:/artifacts',
    '--not-before',
    NOT_BEFORE,
    ...extra,
  ];
}

describe('real benchmark command boundary', () => {
  it('parses explicit initialize and run commands without accepting credentials in argv', () => {
    expect(
      parseBenchmarkCommand([
        'initialize',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
      ]),
    ).toMatchObject({ command: 'initialize', guildId: '1533989004406558851' });
    expect(
      parseBenchmarkCommand([
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
      ]),
    ).toMatchObject({ command: 'migrate', guildId: '1533989004406558851' });
    expect(() =>
      parseBenchmarkCommand([
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
      ]),
    ).toThrow(/not valid for migrate/);
    expect(
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--not-before',
        NOT_BEFORE,
        '--request',
        'Build a gaming server',
      ]),
    ).toMatchObject({ command: 'run', request: 'Build a gaming server', notBefore: NOT_BEFORE });
    expect(
      parseBenchmarkCommand([...runArgs(), '--inject-result-loss-trial', 'trial-01']),
    ).toMatchObject({ injectResultLossTrial: 'trial-01' });
    expect(() => parseBenchmarkCommand([...runArgs(), '--token', 'never-allowed'])).toThrow(
      /unknown flag/,
    );
  });

  it('binds the response-loss injector to one manifest trial and never exposes credentials', async () => {
    const dependencies = { marker: true };
    const manifest = { trials: [{ trial_id: 'trial-01' }] };
    const injected = attachApplyResultLossInjection(dependencies, manifest, 'trial-01');
    await expect(injected.injectApplyResultLoss({ trial: { trial_id: 'trial-02' } })).resolves.toBe(
      undefined,
    );
    await expect(
      injected.injectApplyResultLoss({ trial: { trial_id: 'trial-01' } }),
    ).rejects.toMatchObject({ code: 'RESULT_LOST_AFTER_MUTATION', retriable: true });
    await expect(injected.injectApplyResultLoss({ trial: { trial_id: 'trial-01' } })).resolves.toBe(
      undefined,
    );
    expect(JSON.stringify(injected)).not.toContain('token');
  });

  it('rejects missing, duplicate, malformed, and command-specific flags', () => {
    expect(() => parseBenchmarkCommand(['run'])).toThrow(/missing/);
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
      ]),
    ).toThrow(/not-before/);
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        'short',
        '--artifact-root',
        'C:/artifacts',
        '--not-before',
        NOT_BEFORE,
      ]),
    ).toThrow(/Git SHA/);
    expect(() => parseBenchmarkCommand([...runArgs('--expected-commit', COMMIT)])).toThrow(
      /duplicate/,
    );
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--not-before',
        NOT_BEFORE,
        '--guild',
        '1533989004406558851',
      ]),
    ).toThrow(/only valid for initialize/);
    expect(() =>
      parseBenchmarkCommand([...runArgs().slice(0, 5), '--not-before', '2026-08-14 04:03:25Z']),
    ).toThrow(/strict RFC3339/);
    expect(() =>
      parseBenchmarkCommand([
        'initialize',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
        '--not-before',
        NOT_BEFORE,
      ]),
    ).toThrow(/only valid for run/);
    expect(() =>
      parseBenchmarkCommand([
        'initialize',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
        '--inject-result-loss-trial',
        'trial-01',
      ]),
    ).toThrow(/only valid for run/);
    expect(() =>
      parseBenchmarkCommand([
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--not-before',
        NOT_BEFORE,
      ]),
    ).toThrow(/not valid for migrate/);
    for (const args of [
      [
        'initialize',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
      ],
      [
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
      ],
      runArgs(),
    ]) {
      expect(() => parseBenchmarkCommand([...args, '--started-at', NOT_BEFORE])).toThrow(
        /only valid for unlock/,
      );
    }
  });

  it('checks not-before before build, baseline, artifact, or Discord work', async () => {
    await expect(
      main(runArgs(), { DISCORD_TOKEN: 'test-token' }, { now: () => Date.parse(NOT_BEFORE) - 1 }),
    ).rejects.toThrow(/not-before has not elapsed/);
  });

  it('serializes initialize, migrate, and run under the same controlled-pool lock', async () => {
    const startedAtMilliseconds = Date.parse('2026-08-14T04:03:25.930Z');
    const calls = [];
    const acquireLock = async ({ botId, guildIds, owner }) => {
      calls.push({ botId, guildIds, owner });
      return { release: async () => calls.push({ released: owner.run_id }) };
    };
    const common = { DISCORD_TOKEN: 'caller-token' };
    const initializeArgs = [
      'initialize',
      '--expected-commit',
      COMMIT,
      '--artifact-root',
      'C:/artifacts',
      '--guild',
      '1533989004406558851',
      '--confirmation',
      'RESET_DISPOSABLE_GUILD:1533989004406558851',
    ];
    const migrateArgs = [
      'migrate',
      '--expected-commit',
      COMMIT,
      '--artifact-root',
      'C:/artifacts',
      '--guild',
      '1533989004406558851',
    ];
    const runArgsPastCooldown = [
      'run',
      '--expected-commit',
      COMMIT,
      '--artifact-root',
      'C:/artifacts',
      '--not-before',
      '2020-01-01T00:00:00.000Z',
    ];
    const handlers = {
      initialize: async (_options, _token, context) => ({
        command: 'initialize',
        run_id: context.runId,
      }),
      migrate: async () => ({ command: 'migrate' }),
      run: async (_options, _token, context) => ({ command: 'run', run_id: context.runId }),
    };
    await main(initializeArgs, common, {
      now: () => startedAtMilliseconds,
      acquireLock,
      initialize: handlers.initialize,
      migrate: handlers.migrate,
      run: handlers.run,
    });
    await main(migrateArgs, common, {
      now: () => startedAtMilliseconds,
      acquireLock,
      initialize: handlers.initialize,
      migrate: handlers.migrate,
      run: handlers.run,
    });
    await main(runArgsPastCooldown, common, {
      now: () => startedAtMilliseconds,
      acquireLock,
      initialize: handlers.initialize,
      migrate: handlers.migrate,
      run: handlers.run,
    });
    expect(calls.filter((entry) => entry.botId).map((entry) => entry.owner.commit)).toEqual([
      COMMIT,
      COMMIT,
      COMMIT,
    ]);
    expect(calls.filter((entry) => entry.released)).toHaveLength(3);
  });

  it('accepts an explicit unlock command without allowing an artifact-root override', () => {
    const unlockArgs = [
      'unlock',
      '--expected-commit',
      COMMIT,
      '--run-id',
      'real-stale',
      '--started-at',
      NOT_BEFORE,
      '--confirmation',
      'RELEASE_DISCORD_MCP_LOCK:expected',
      '--pid',
      OWNER_PID,
      '--hostname',
      OWNER_HOSTNAME,
    ];
    expect(parseBenchmarkCommand(unlockArgs)).toMatchObject({
      command: 'unlock',
      runId: 'real-stale',
      startedAt: NOT_BEFORE,
      pid: Number(OWNER_PID),
      hostname: OWNER_HOSTNAME,
    });
    for (const forbidden of ['--guild', '--not-before', '--artifact-root', '--request']) {
      expect(() => parseBenchmarkCommand([...unlockArgs, forbidden, 'unexpected'])).toThrow(
        /not valid for unlock/,
      );
    }
    for (const missing of ['--pid', '--hostname']) {
      const index = unlockArgs.indexOf(missing);
      expect(() =>
        parseBenchmarkCommand([...unlockArgs.slice(0, index), ...unlockArgs.slice(index + 2)]),
      ).toThrow(new RegExp(`missing ${missing}`));
    }
    const invalidPidArgs = [...unlockArgs];
    invalidPidArgs[invalidPidArgs.indexOf('--pid') + 1] = '0';
    expect(() => parseBenchmarkCommand(invalidPidArgs)).toThrow(/positive safe integer/);
  });

  it('dispatches unlock before reading DISCORD_TOKEN', async () => {
    const calls = [];
    await expect(
      main(
        [
          'unlock',
          '--expected-commit',
          COMMIT,
          '--run-id',
          'real-stale',
          '--started-at',
          NOT_BEFORE,
          '--confirmation',
          'RELEASE_DISCORD_MCP_LOCK:expected',
          '--pid',
          OWNER_PID,
          '--hostname',
          OWNER_HOSTNAME,
        ],
        {},
        {
          unlock: async (options) => {
            calls.push(options);
            return { ok: true, command: 'unlock' };
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true, command: 'unlock' });
    expect(calls[0]).toMatchObject({ pid: Number(OWNER_PID), hostname: OWNER_HOSTNAME });
  });

  it('allows the exact not-before boundary', () => {
    expect(assertBenchmarkNotBefore(NOT_BEFORE, Date.parse(NOT_BEFORE))).toBe(
      Date.parse(NOT_BEFORE),
    );
  });

  it('returns a nonzero process code for a completed failed gate', () => {
    expect(benchmarkProcessExitCode({ command: 'run', ok: false })).toBe(1);
    expect(benchmarkProcessExitCode({ command: 'run', ok: true })).toBe(0);
  });

  it('publishes the completed campaign with the exact identity and caller secret', async () => {
    const input = {
      runDirectory: 'C:/artifacts/runs/real-01',
      runId: 'real-01',
      commit: COMMIT,
      integrityKey: 'caller-owned-secret',
    };
    let received;
    await expect(
      publishCampaignAttestation(input, async (value) => {
        received = value;
        return { schema_version: 'discord-mcp.real-benchmark-attestation.v1' };
      }),
    ).resolves.toEqual({ schema_version: 'discord-mcp.real-benchmark-attestation.v1' });
    expect(received).toEqual(input);
  });

  it('does not mask a campaign failure when lock release fails closed', async () => {
    const primary = new Error('campaign failure');
    await expect(
      (async () => {
        try {
          throw primary;
        } finally {
          await releaseCampaignLock(
            {
              release: async () => {
                throw new Error('lock metadata changed');
              },
            },
            primary,
          );
        }
      })(),
    ).rejects.toBe(primary);
  });
});
