import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  GROK_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  main,
  parseGrokCliActivationCampaignArgs,
  runGrokCliActivationCampaign,
} from './grok-cli-activation-campaign.mjs';

const RELEASE = '0.26.0';
const RUN_ID = 'activation-grok-20260815';
const HOST_VERSION = '1.0.3';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SOURCE_COMMIT = 'a'.repeat(40);
const TOKEN = 'discord-token-never-public';
const ARTIFACT_ROOT = resolve('grok-activation-campaign-artifacts');

function confirmation() {
  return `${GROK_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${RELEASE}:${RUN_ID}:${GUILD_ID}`;
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
    schema_version: 'discord-mcp.activation-trial.v3',
    host: 'grok-cli',
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
    schema_version: 'discord-mcp.activation-trials-verifier.v2',
    verified: true,
    host_count: 1,
  }));
  const writeArtifact = vi.fn(async () => undefined);
  const prepareStore = vi.fn(async () => ({ writeArtifact }));
  const validateTrial = vi.fn(() => true);
  return { runTrial, verifyAggregate, writeArtifact, prepareStore, validateTrial, ...overrides };
}

describe('Grok Build CLI activation campaign', () => {
  it('parses one controlled target and campaign-bound approval', () => {
    expect(parseGrokCliActivationCampaignArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      hostVersion: HOST_VERSION,
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
    });
    expect(() => parseGrokCliActivationCampaignArgs([...argv(), '--guild', GUILD_ID])).toThrow(
      /arguments are invalid/u,
    );
    expect(() => parseGrokCliActivationCampaignArgs(argv().slice(0, -2))).toThrow(
      /arguments are invalid/u,
    );
  });

  it('runs exactly three sequential trials and publishes one verified bundle', async () => {
    const dependencies = seams();
    const result = await runGrokCliActivationCampaign(request(), dependencies);
    expect(result).toMatchObject({
      schema_version: GROK_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      public_aggregate: { verified: true },
    });
    expect(dependencies.runTrial.mock.calls.map(([input]) => input.trialId)).toEqual([
      'grok-cli-activation-01',
      'grok-cli-activation-02',
      'grok-cli-activation-03',
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
        `APPROVE_GROK_CLI_ACTIVATION:${RELEASE}:${input.trialId}`,
      );
      expect(input.writeApproval).toBe(
        `APPROVE_GROK_CLI_ACTIVATION_WRITE:${RELEASE}:${input.trialId}`,
      );
    }
    expect(dependencies.writeArtifact).toHaveBeenCalledTimes(4);
    expect(dependencies.writeArtifact).toHaveBeenLastCalledWith(
      'results/activation-trials-bundle.json',
      expect.objectContaining({ schema_version: 'discord-mcp.activation-trials-bundle.v2' }),
    );
  });

  it('preflights xAI authentication before reserving an artifact run', async () => {
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT', ARTIFACT_ROOT);
    const prepareStore = vi.fn();
    try {
      await expect(runGrokCliActivationCampaign(request(), { prepareStore })).rejects.toThrow(
        /XAI_API_KEY preflight failed/u,
      );
      expect(prepareStore).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops on first failure and keeps operator output secret-free', async () => {
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, artifact: artifact('grok-cli-activation-01') })
      .mockResolvedValueOnce({
        ok: false,
        artifact: artifact('grok-cli-activation-02', { result: 'failed' }),
      });
    const dependencies = seams({ runTrial });
    const result = await runGrokCliActivationCampaign(request(), dependencies);
    expect(result).toMatchObject({ ok: false, completed_trials: 1 });
    expect(runTrial).toHaveBeenCalledTimes(2);
    expect(dependencies.verifyAggregate).not.toHaveBeenCalled();

    const writes = [];
    const code = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}`,
        XAI_API_KEY: 'xai-test-key',
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => writes.push(value) },
      runCampaign: async () => ({
        schema_version: GROK_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
        ok: true,
        bundle_relative_path: 'runs/fixture/results/activation-trials-bundle.json',
        public_aggregate: { verified: true },
      }),
    });
    expect(code).toBe(0);
    expect(writes.join('')).not.toContain(TOKEN);
  });
});
