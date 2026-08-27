import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVATION_ATTESTATION_REF_SCHEMA,
  activationTrialDigest,
} from './activation-artifact.mjs';
import {
  ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
  main,
  parseAntigravityCliActivationCampaignArgs,
  runAntigravityCliActivationCampaign,
} from './antigravity-cli-activation-campaign.mjs';

const RELEASE = '0.23.0';
const RUN_ID = 'activation-antigravity-20260815';
const HOST_VERSION = '1.1.13';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SOURCE_COMMIT = 'a'.repeat(40);
const TOKEN = 'discord-token-never-public';
const ARTIFACT_ROOT = resolve('antigravity-activation-campaign-artifacts');

function confirmation() {
  return `${ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${RELEASE}:${RUN_ID}:${GUILD_ID}`;
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
    host: 'antigravity-cli',
    host_version: HOST_VERSION,
    release: RELEASE,
    source_commit: SOURCE_COMMIT,
    trial_id: trialId,
    execution_mode: 'live',
    result: 'passed',
    ...overrides,
  };
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function completeArtifact(trialId, index) {
  const value = {
    ...artifact(trialId),
    phase_durations_ms: {
      install: 100,
      setup: 200,
      client_ready: 300,
      first_request: 400,
      apply: 500,
      evidence: 600,
      restore: 700,
      total: 3_000,
    },
    readiness: {
      install: 'ready',
      setup: 'ready',
      client: 'ready',
      first_request: 'ready',
    },
    terminal_status: 'passed',
    evidence: { apply: 'completed', guild_blueprint_evidence: 'verified' },
    digests: {
      build: digest('a'),
      evidence: digest(['b', 'c', 'd'][index]),
      launcher: digest('5'),
      session: digest(['e', 'f', '0'][index]),
    },
    safety: {
      secret_free: true,
      caller_owned_bot: true,
      binding_verified: true,
      clean_profile: true,
      isolated_session: true,
      dangerous_permissions: false,
    },
    baseline: {
      restored: true,
      exact: true,
      before_digest: digest('1'),
      after_digest: digest('1'),
    },
  };
  return {
    ...value,
    attestation: {
      schema_version: ACTIVATION_ATTESTATION_REF_SCHEMA,
      envelope_digest: digest(['2', '3', '4'][index]),
      trial_digest: activationTrialDigest(value),
    },
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

describe('Antigravity CLI activation campaign', () => {
  it('parses one controlled target and campaign-bound approval', () => {
    expect(parseAntigravityCliActivationCampaignArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      hostVersion: HOST_VERSION,
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
    });
    expect(() =>
      parseAntigravityCliActivationCampaignArgs([...argv(), '--guild', GUILD_ID]),
    ).toThrow(/arguments are invalid/);
    expect(() => parseAntigravityCliActivationCampaignArgs(argv().slice(0, -2))).toThrow(
      /arguments are invalid/,
    );
  });

  it('runs exactly three sequential live trials and publishes one verified bundle', async () => {
    const dependencies = seams();
    const result = await runAntigravityCliActivationCampaign(request(), dependencies);

    expect(result).toEqual({
      schema_version: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: {
        schema_version: 'discord-mcp.activation-trials-verifier.v2',
        verified: true,
        host_count: 1,
      },
    });
    expect(dependencies.runTrial.mock.calls.map(([input]) => input.trialId)).toEqual([
      'antigravity-cli-activation-01',
      'antigravity-cli-activation-02',
      'antigravity-cli-activation-03',
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
        `APPROVE_ANTIGRAVITY_CLI_ACTIVATION:${RELEASE}:${input.trialId}`,
      );
      expect(input.writeApproval).toBe(
        `APPROVE_ANTIGRAVITY_CLI_ACTIVATION_WRITE:${RELEASE}:${input.trialId}`,
      );
    }
    expect(dependencies.writeArtifact).toHaveBeenCalledTimes(4);
    expect(dependencies.writeArtifact).toHaveBeenLastCalledWith(
      'results/activation-trials-bundle.json',
      expect.objectContaining({
        schema_version: 'discord-mcp.activation-trials-bundle.v2',
      }),
    );
  });

  it('accepts complete Antigravity artifacts through the production validator', async () => {
    let index = 0;
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: completeArtifact(trialId, index++),
    }));
    const dependencies = seams({ runTrial, validateTrial: undefined });
    await expect(
      runAntigravityCliActivationCampaign(request(), dependencies),
    ).resolves.toMatchObject({ ok: true });
    expect(runTrial).toHaveBeenCalledTimes(3);
  });

  it('preflights model authentication before reserving an artifact run', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT', ARTIFACT_ROOT);
    const prepareStore = vi.fn();
    try {
      await expect(
        runAntigravityCliActivationCampaign(request(), { prepareStore }),
      ).rejects.toThrow(/GEMINI_API_KEY preflight failed/);
      expect(prepareStore).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops at the first failed trial and never publishes a partial bundle', async () => {
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        artifact: artifact('antigravity-cli-activation-01'),
      })
      .mockResolvedValueOnce({
        ok: false,
        artifact: artifact('antigravity-cli-activation-02', { result: 'failed' }),
      });
    const dependencies = seams({ runTrial });
    const result = await runAntigravityCliActivationCampaign(request(), dependencies);

    expect(result).toMatchObject({
      schema_version: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: false,
      completed_trials: 1,
      failed_trial: { trial_id: 'antigravity-cli-activation-02', result: 'failed' },
    });
    expect(runTrial).toHaveBeenCalledTimes(2);
    expect(dependencies.verifyAggregate).not.toHaveBeenCalled();
    expect(dependencies.writeArtifact).toHaveBeenCalledTimes(2);
  });

  it.each([
    { host: 'codex' },
    { host_version: '9.9.9' },
    { source_commit: 'b'.repeat(40) },
    { trial_id: 'antigravity-cli-activation-99' },
    { execution_mode: 'test' },
  ])('fails closed on wrong trial identity (%o)', async (identity) => {
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: artifact(trialId, identity),
    }));
    const dependencies = seams({ runTrial });
    await expect(runAntigravityCliActivationCampaign(request(), dependencies)).rejects.toThrow(
      /before producing a valid artifact/,
    );
    expect(runTrial).toHaveBeenCalledOnce();
    expect(dependencies.verifyAggregate).not.toHaveBeenCalled();
    expect(dependencies.writeArtifact).toHaveBeenCalledWith(
      'results/antigravity-cli-activation-01.failure.json',
      expect.objectContaining({ result: 'failed' }),
    );
  });

  it('refuses a non-verifying aggregate and never writes the bundle', async () => {
    const dependencies = seams({
      verifyAggregate: vi.fn(() => ({
        schema_version: 'discord-mcp.activation-trials-verifier.v2',
        verified: false,
      })),
    });
    await expect(runAntigravityCliActivationCampaign(request(), dependencies)).rejects.toThrow(
      /public verification failed/,
    );
    expect(dependencies.writeArtifact).toHaveBeenCalledTimes(3);
    expect(dependencies.writeArtifact).not.toHaveBeenCalledWith(
      'results/activation-trials-bundle.json',
      expect.anything(),
    );
  });

  it('keeps CLI success and failure output secret-free', async () => {
    const runCampaign = vi.fn(async () => ({
      schema_version: ANTIGRAVITY_CLI_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: { verified: true },
    }));
    const writes = [];
    const code = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}`,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => writes.push(value) },
      runCampaign,
    });
    expect(code).toBe(0);
    expect(runCampaign).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    expect(writes.join('')).not.toContain(TOKEN);

    const unsafeWrites = [];
    const unsafeCode = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: TOKEN,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => unsafeWrites.push(value) },
      runCampaign: async () => ({ ok: true, token: TOKEN }),
    });
    expect(unsafeCode).toBe(1);
    expect(unsafeWrites.join('')).not.toContain(TOKEN);
    expect(JSON.parse(unsafeWrites.join(''))).toMatchObject({ ok: false });
  });
});
