import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  CURSOR_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  main,
  parseCursorCliActivationCampaignArgs,
  runCursorCliActivationCampaign,
} from './cursor-cli-activation-campaign.mjs';

const RELEASE = '0.23.0';
const RUN_ID = 'activation-cursor-20260815';
const HOST_VERSION = '2.4.1';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SOURCE_COMMIT = 'a'.repeat(40);
const TOKEN = 'discord-token-never-public';
const ARTIFACT_ROOT = resolve('cursor-activation-campaign-artifacts');

function confirmation() {
  return `${CURSOR_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${RELEASE}:${RUN_ID}:${GUILD_ID}`;
}

function argv() {
  return [
    '--release',
    RELEASE,
    '--run-id',
    RUN_ID,
    '--host-version',
    HOST_VERSION,
    '--source-commit',
    SOURCE_COMMIT,
    '--guild',
    GUILD_ID,
    '--confirmation',
    confirmation(),
  ];
}

function request(overrides = {}) {
  return {
    release: RELEASE,
    runId: RUN_ID,
    hostVersion: HOST_VERSION,
    sourceCommit: SOURCE_COMMIT,
    guildId: GUILD_ID,
    confirmation: confirmation(),
    token: TOKEN,
    cwd: resolve('.'),
    artifactRoot: ARTIFACT_ROOT,
    ...overrides,
  };
}

function artifact(trialId, overrides = {}) {
  return {
    schema_version: 'discord-mcp.activation-trial.v2',
    host: 'cursor-cli',
    host_version: HOST_VERSION,
    release: RELEASE,
    source_commit: SOURCE_COMMIT,
    trial_id: trialId,
    execution_mode: 'live',
    result: 'passed',
    ...overrides,
  };
}

function seams(overrides = {}) {
  const runTrial = vi.fn(async ({ trialId }) => ({ ok: true, artifact: artifact(trialId) }));
  const verifyAggregate = vi.fn(() => ({
    schema_version: 'discord-mcp.activation-trials-verifier.v1',
    verified: true,
    host_count: 1,
  }));
  const writeArtifact = vi.fn(async () => undefined);
  const prepareStore = vi.fn(async () => ({ writeArtifact }));
  const validateTrial = vi.fn(() => true);
  return { runTrial, verifyAggregate, writeArtifact, prepareStore, validateTrial, ...overrides };
}

describe('Cursor Agent CLI activation campaign', () => {
  it('parses one controlled target and campaign-bound approval', () => {
    expect(parseCursorCliActivationCampaignArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      hostVersion: HOST_VERSION,
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
    });
    expect(() => parseCursorCliActivationCampaignArgs([...argv(), '--guild', GUILD_ID])).toThrow(
      /arguments are invalid/,
    );
    expect(() => parseCursorCliActivationCampaignArgs(argv().slice(0, -2))).toThrow(
      /arguments are invalid/,
    );
  });

  it('runs exactly three sequential trials with exact host approvals and publishes one bundle', async () => {
    const dependencies = seams();
    const result = await runCursorCliActivationCampaign(request(), dependencies);
    expect(result).toMatchObject({
      schema_version: CURSOR_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      public_aggregate: { verified: true },
    });
    expect(dependencies.runTrial.mock.calls.map(([input]) => input.trialId)).toEqual([
      'cursor-cli-activation-01',
      'cursor-cli-activation-02',
      'cursor-cli-activation-03',
    ]);
    for (const [input] of dependencies.runTrial.mock.calls) {
      expect(input).toMatchObject({
        release: RELEASE,
        runId: RUN_ID,
        hostVersion: HOST_VERSION,
        sourceCommit: SOURCE_COMMIT,
        executionMode: 'live',
        token: TOKEN,
        target: {
          guildId: GUILD_ID,
          botId: BOT_ID,
          controlled: true,
          callerOwned: true,
        },
      });
      expect(input.operatorConfirmation).toBe(
        `APPROVE_CURSOR_CLI_ACTIVATION:${RELEASE}:${input.trialId}`,
      );
      expect(input.writeApproval).toBe(
        `APPROVE_CURSOR_CLI_ACTIVATION_WRITE:${RELEASE}:${input.trialId}`,
      );
    }
    expect(dependencies.writeArtifact).toHaveBeenCalledTimes(4);
    expect(dependencies.writeArtifact).toHaveBeenLastCalledWith(
      'results/activation-trials-bundle.json',
      expect.objectContaining({ schema_version: 'discord-mcp.activation-trials-bundle.v1' }),
    );
  });

  it('preflights Cursor authentication before reserving an artifact run', async () => {
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT', ARTIFACT_ROOT);
    const prepareStore = vi.fn();
    try {
      await expect(runCursorCliActivationCampaign(request(), { prepareStore })).rejects.toThrow(
        /CURSOR_API_KEY preflight failed/,
      );
      expect(prepareStore).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops on first failure and keeps operator output secret-free', async () => {
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, artifact: artifact('cursor-cli-activation-01') })
      .mockResolvedValueOnce({
        ok: false,
        artifact: artifact('cursor-cli-activation-02', { result: 'failed' }),
      });
    const dependencies = seams({ runTrial });
    const result = await runCursorCliActivationCampaign(request(), dependencies);
    expect(result).toMatchObject({ ok: false, completed_trials: 1 });
    expect(runTrial).toHaveBeenCalledTimes(2);
    expect(dependencies.verifyAggregate).not.toHaveBeenCalled();

    const writes = [];
    const code = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}`,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => writes.push(value) },
      runCampaign: async () => ({
        schema_version: CURSOR_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
        ok: true,
        bundle_relative_path: 'runs/fixture/results/activation-trials-bundle.json',
        public_aggregate: { verified: true },
      }),
    });
    expect(code).toBe(0);
    expect(writes.join('')).not.toContain(TOKEN);
  });
});
