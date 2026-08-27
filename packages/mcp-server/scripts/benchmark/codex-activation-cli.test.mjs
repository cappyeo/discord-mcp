import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_ACTIVATION_CONFIRMATION_PREFIX,
  CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  main,
  parseCodexActivationArgs,
} from './codex-activation-trial.mjs';

const RELEASE = '0.22.0';
const RUN_ID = 'activation-codex-20260814';
const TRIAL_ID = 'codex-01';
const GUILD_ID = '1537332825978568744';
const SOURCE_COMMIT = 'b8b4705ee742f52be3d4c2d08f7906d23511b0bc';

function argv() {
  return [
    '--release',
    RELEASE,
    '--run-id',
    RUN_ID,
    '--trial-id',
    TRIAL_ID,
    '--host-version',
    '0.147.0',
    '--source-commit',
    SOURCE_COMMIT,
    '--guild',
    GUILD_ID,
    '--confirmation',
    `${CODEX_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    '--write-approval',
    `${CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
  ];
}

describe('Codex activation CLI', () => {
  it('parses one explicit, fully bound trial', () => {
    expect(parseCodexActivationArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      trialId: TRIAL_ID,
      hostVersion: '0.147.0',
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      operatorConfirmation: `${CODEX_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      writeApproval: `${CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    });
  });

  it.each([
    [[...argv(), '--guild', GUILD_ID]],
    [argv().slice(0, -2)],
    [['--unknown', 'value']],
    [[...argv().slice(0, 10), '--guild', '1533998797863256165', ...argv().slice(12)]],
  ])('rejects incomplete, duplicate, or unknown arguments', (input) => {
    expect(() => parseCodexActivationArgs(input)).toThrow(/invalid activation arguments/);
  });

  it('passes only the Bot B environment credential into the live trial', async () => {
    const runTrial = vi.fn(async () => ({
      ok: true,
      artifact: { schema_version: 'discord-mcp.activation-trial.v3', result: 'passed' },
    }));
    const writes = [];
    const code = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: 'Bot test-b-token',
        DISCORD_TOKEN: 'wrong-token',
      },
      stdout: { write: (value) => writes.push(value) },
      runTrial,
    });

    expect(code).toBe(0);
    expect(runTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'test-b-token',
        executionMode: 'live',
        target: {
          guildId: GUILD_ID,
          botId: '1533719084636700773',
          controlled: true,
          callerOwned: true,
        },
      }),
    );
    expect(writes.join('')).not.toContain('test-b-token');
  });

  it('fails closed without exposing argument or credential details', async () => {
    const writes = [];
    const code = await main({
      argv: argv(),
      environment: {},
      stdout: { write: (value) => writes.push(value) },
      runTrial: vi.fn(),
    });

    expect(code).toBe(1);
    expect(writes.join('')).toBe(
      '{"schema_version":"discord-mcp.activation-trial-cli.v1","ok":false,"error":"activation trial failed"}\n',
    );
  });
});
