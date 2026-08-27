import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVATION_ATTESTATION_REF_SCHEMA,
  activationTrialDigest,
} from './activation-artifact.mjs';
import {
  CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
  main,
  parseCodexActivationCampaignArgs,
  runCodexActivationCampaign,
} from './codex-activation-campaign.mjs';

const RELEASE = '0.22.0';
const RUN_ID = 'activation-codex-20260814';
const GUILD_ID = '1537332825978568744';
const SOURCE_COMMIT = 'b8b4705ee742f52be3d4c2d08f7906d23511b0bc';
const ARTIFACT_ROOT = resolve('activation-campaign-artifacts');

function confirmation() {
  return `${CODEX_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${RELEASE}:${RUN_ID}:${GUILD_ID}`;
}

function argv() {
  return [
    '--release',
    RELEASE,
    '--run-id',
    RUN_ID,
    '--host-version',
    '0.147.0',
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
    hostVersion: '0.147.0',
    sourceCommit: SOURCE_COMMIT,
    guildId: GUILD_ID,
    confirmation: confirmation(),
    token: 'test-token',
    cwd: resolve('.'),
    artifactRoot: ARTIFACT_ROOT,
    ...overrides,
  };
}

function passedArtifact(trialId) {
  return {
    schema_version: 'discord-mcp.activation-trial.v3',
    host: 'codex',
    host_version: '0.147.0',
    release: RELEASE,
    source_commit: SOURCE_COMMIT,
    trial_id: trialId,
    execution_mode: 'live',
    result: 'passed',
  };
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function completePassedArtifact(trialId, index) {
  const value = {
    schema_version: 'discord-mcp.activation-trial.v3',
    host: 'codex',
    host_version: '0.147.0',
    release: RELEASE,
    source_commit: SOURCE_COMMIT,
    trial_id: trialId,
    execution_mode: 'live',
    result: 'passed',
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

function dependencies(overrides = {}) {
  const runTrial = vi.fn(async ({ trialId }) => ({
    ok: true,
    artifact: passedArtifact(trialId),
  }));
  const verifyAggregate = vi.fn(() => ({
    schema_version: 'discord-mcp.activation-trials-verifier.v2',
    verified: true,
    host_count: 1,
  }));
  const writeArtifact = vi.fn(async () => undefined);
  const prepareStore = vi.fn(async () => ({ writeArtifact }));
  const validateTrial = vi.fn(() => true);
  return { runTrial, verifyAggregate, prepareStore, validateTrial, writeArtifact, ...overrides };
}

describe('Codex activation campaign', () => {
  it('parses one release, target, and campaign-bound approval', () => {
    expect(parseCodexActivationCampaignArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      hostVersion: '0.147.0',
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
    });
  });

  it.each([
    [[...argv(), '--guild', GUILD_ID]],
    [argv().slice(0, -2)],
    [['--unknown', 'value']],
    [[...argv().slice(0, -2), '--confirmation', `${confirmation()}-wrong`]],
  ])('rejects incomplete, duplicate, unknown, or mismatched arguments', (input) => {
    expect(() => parseCodexActivationCampaignArgs(input)).toThrow(/arguments are invalid/);
  });

  it('runs exactly three sequential live trials and writes one verified bundle', async () => {
    const seams = dependencies();
    const result = await runCodexActivationCampaign(request(), seams);

    expect(result).toEqual({
      schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: {
        schema_version: 'discord-mcp.activation-trials-verifier.v2',
        verified: true,
        host_count: 1,
      },
    });
    expect(seams.runTrial).toHaveBeenCalledTimes(3);
    expect(seams.runTrial.mock.calls.map(([input]) => input.trialId)).toEqual([
      'codex-activation-01',
      'codex-activation-02',
      'codex-activation-03',
    ]);
    for (const [input] of seams.runTrial.mock.calls) {
      expect(input).toMatchObject({
        release: RELEASE,
        runId: RUN_ID,
        sourceCommit: SOURCE_COMMIT,
        executionMode: 'live',
        token: 'test-token',
        target: {
          guildId: GUILD_ID,
          botId: '1533719084636700773',
          controlled: true,
          callerOwned: true,
        },
      });
      expect(input.operatorConfirmation).toBe(
        `APPROVE_CODEX_ACTIVATION:${RELEASE}:${input.trialId}`,
      );
      expect(input.writeApproval).toBe(
        `APPROVE_CODEX_ACTIVATION_WRITE:${RELEASE}:${input.trialId}`,
      );
    }
    expect(seams.verifyAggregate).toHaveBeenCalledOnce();
    expect(seams.prepareStore).toHaveBeenCalledWith({
      cwd: resolve('.'),
      artifactRoot: ARTIFACT_ROOT,
      runId: RUN_ID,
    });
    expect(seams.writeArtifact).toHaveBeenCalledTimes(4);
    expect(seams.writeArtifact).toHaveBeenLastCalledWith('results/activation-trials-bundle.json', {
      schema_version: 'discord-mcp.activation-trials-bundle.v2',
      trials: expect.arrayContaining([
        passedArtifact('codex-activation-01'),
        passedArtifact('codex-activation-02'),
        passedArtifact('codex-activation-03'),
      ]),
    });
  });

  it('accepts complete trial artifacts through the production validator', async () => {
    let index = 0;
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: completePassedArtifact(trialId, index++),
    }));
    const seams = dependencies({ runTrial, validateTrial: undefined });

    await expect(runCodexActivationCampaign(request(), seams)).resolves.toMatchObject({
      ok: true,
    });
    expect(runTrial).toHaveBeenCalledTimes(3);
  });

  it('stops after the first failed trial and never publishes a partial bundle', async () => {
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, artifact: passedArtifact('codex-activation-01') })
      .mockResolvedValueOnce({
        ok: false,
        artifact: { ...passedArtifact('codex-activation-02'), result: 'failed' },
      });
    const seams = dependencies({ runTrial });

    const result = await runCodexActivationCampaign(request(), seams);

    expect(result).toMatchObject({
      schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: false,
      completed_trials: 1,
      failed_trial: { trial_id: 'codex-activation-02', result: 'failed' },
    });
    expect(runTrial).toHaveBeenCalledTimes(2);
    expect(seams.verifyAggregate).not.toHaveBeenCalled();
    expect(seams.writeArtifact).toHaveBeenCalledTimes(2);
    expect(seams.writeArtifact).toHaveBeenLastCalledWith(
      'results/codex-activation-02.json',
      expect.objectContaining({ result: 'failed' }),
    );
  });

  it('rejects contradictory runner and artifact results', async () => {
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: false,
      artifact: passedArtifact(trialId),
    }));
    const seams = dependencies({ runTrial });

    await expect(runCodexActivationCampaign(request(), seams)).rejects.toThrow(
      /before producing a valid artifact/,
    );
    expect(seams.writeArtifact).toHaveBeenCalledWith(
      'results/codex-activation-01.failure.json',
      expect.objectContaining({ result: 'failed' }),
    );
    expect(seams.writeArtifact).not.toHaveBeenCalledWith(
      'results/codex-activation-01.json',
      expect.anything(),
    );
  });

  it('rejects the campaign approval before starting any trial', async () => {
    const seams = dependencies();
    await expect(
      runCodexActivationCampaign(request({ confirmation: `${confirmation()}-wrong` }), seams),
    ).rejects.toThrow(/confirmation/);
    expect(seams.runTrial).not.toHaveBeenCalled();
  });

  it('records an unexpected trial failure and never starts a later trial', async () => {
    const runTrial = vi.fn(async () => {
      throw new Error('private failure detail');
    });
    const seams = dependencies({ runTrial });

    await expect(runCodexActivationCampaign(request(), seams)).rejects.toThrow(
      /before producing a valid artifact/,
    );
    expect(runTrial).toHaveBeenCalledOnce();
    expect(seams.writeArtifact).toHaveBeenCalledOnce();
    expect(seams.writeArtifact).toHaveBeenCalledWith('results/codex-activation-01.failure.json', {
      schema_version: 'discord-mcp.codex-activation-campaign-trial-failure.v1',
      trial_id: 'codex-activation-01',
      result: 'failed',
      error: 'activation trial did not produce a valid artifact',
    });
  });

  it('retains all three trial artifacts when final bundle publication fails', async () => {
    const writeArtifact = vi.fn(async (path) => {
      if (path === 'results/activation-trials-bundle.json') {
        throw new Error('simulated exclusive write failure');
      }
    });
    const seams = dependencies({
      prepareStore: vi.fn(async () => ({ writeArtifact })),
      writeArtifact,
    });

    await expect(runCodexActivationCampaign(request(), seams)).rejects.toThrow(
      /exclusive write failure/,
    );
    expect(seams.runTrial).toHaveBeenCalledTimes(3);
    expect(writeArtifact).toHaveBeenCalledTimes(4);
    expect(writeArtifact.mock.calls.slice(0, 3).map(([path]) => path)).toEqual([
      'results/codex-activation-01.json',
      'results/codex-activation-02.json',
      'results/codex-activation-03.json',
    ]);
  });

  it('never publishes a bundle when the public aggregate does not verify', async () => {
    const seams = dependencies({
      verifyAggregate: vi.fn(() => ({
        schema_version: 'discord-mcp.activation-trials-verifier.v2',
        verified: false,
      })),
    });

    await expect(runCodexActivationCampaign(request(), seams)).rejects.toThrow(
      /public verification failed/,
    );
    expect(seams.runTrial).toHaveBeenCalledTimes(3);
    expect(seams.writeArtifact).toHaveBeenCalledTimes(3);
    expect(seams.writeArtifact).not.toHaveBeenCalledWith(
      'results/activation-trials-bundle.json',
      expect.anything(),
    );
  });

  it('reserves the run id before trial one and rejects reuse', async () => {
    const temporaryBase = process.platform === 'win32' ? homedir() : tmpdir();
    const artifactRoot = await mkdtemp(join(temporaryBase, 'discord-mcp-activation-campaign-'));
    const options = request({ artifactRoot });
    let index = 0;
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: completePassedArtifact(trialId, index++),
    }));
    const seams = dependencies({ runTrial, validateTrial: undefined });
    delete seams.prepareStore;
    try {
      await expect(runCodexActivationCampaign(options, seams)).resolves.toMatchObject({ ok: true });
      await expect(runCodexActivationCampaign(options, seams)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(seams.runTrial).toHaveBeenCalledTimes(3);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('keeps the CLI output secret-free and fails closed without its environment', async () => {
    const runCampaign = vi.fn(async () => ({
      schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: { verified: true },
    }));
    const successWrites = [];
    const successCode = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: 'Bot test-token',
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => successWrites.push(value) },
      runCampaign,
    });
    expect(successCode).toBe(0);
    expect(runCampaign).toHaveBeenCalledWith(expect.objectContaining({ token: 'test-token' }));
    expect(successWrites.join('')).not.toContain('test-token');

    const failureWrites = [];
    const failureCode = await main({
      argv: argv(),
      environment: {},
      stdout: { write: (value) => failureWrites.push(value) },
      runCampaign,
    });
    expect(failureCode).toBe(1);
    expect(failureWrites.join('')).toBe(
      `${JSON.stringify({
        schema_version: CODEX_ACTIVATION_CAMPAIGN_SCHEMA,
        ok: false,
        error: 'activation campaign failed',
      })}\n`,
    );
    expect(runCampaign).toHaveBeenCalledOnce();

    const missingRootCampaign = vi.fn();
    const missingRootWrites = [];
    const missingRootCode = await main({
      argv: argv(),
      environment: { DISCORD_TESTBOT_B_TOKEN: 'test-token' },
      stdout: { write: (value) => missingRootWrites.push(value) },
      runCampaign: missingRootCampaign,
    });
    expect(missingRootCode).toBe(1);
    expect(missingRootCampaign).not.toHaveBeenCalled();
    expect(missingRootWrites.join('')).not.toContain('test-token');
  });
});
