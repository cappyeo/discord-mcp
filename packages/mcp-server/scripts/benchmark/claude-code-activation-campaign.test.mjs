import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVATION_ATTESTATION_REF_SCHEMA,
  activationTrialDigest,
} from './activation-artifact.mjs';
import {
  CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX,
  CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
  main,
  parseClaudeCodeActivationCampaignArgs,
  runClaudeCodeActivationCampaign,
} from './claude-code-activation-campaign.mjs';

const RELEASE = '0.23.0';
const RUN_ID = 'activation-claude-code-20260815';
const HOST_VERSION = '1.0.0';
const GUILD_ID = '1537332825978568744';
const SOURCE_COMMIT = 'b8b4705ee742f52be3d4c2d08f7906d23511b0bc';
const ARTIFACT_ROOT = resolve('activation-campaign-artifacts');
const TOKEN = 'token-never-in-public-artifacts';

function confirmation() {
  return `${CLAUDE_CODE_ACTIVATION_CAMPAIGN_CONFIRMATION_PREFIX}${RELEASE}:${RUN_ID}:${GUILD_ID}`;
}

function argv(overrides = {}) {
  return [
    '--release',
    overrides.release ?? RELEASE,
    '--run-id',
    overrides.runId ?? RUN_ID,
    '--host-version',
    overrides.hostVersion ?? HOST_VERSION,
    '--source-commit',
    overrides.sourceCommit ?? SOURCE_COMMIT,
    '--guild',
    overrides.guildId ?? GUILD_ID,
    '--confirmation',
    overrides.confirmation ?? confirmation(),
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

function fixtureArtifact(trialId, overrides = {}) {
  return {
    schema_version: 'fixture.activation-trial.v1',
    host: 'claude-code',
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
  const runTrial = vi.fn(async ({ trialId }) => ({
    ok: true,
    artifact: fixtureArtifact(trialId),
  }));
  const verifyAggregate = vi.fn(() => ({
    schema_version: 'discord-mcp.activation-trials-verifier.v1',
    verified: true,
    host_count: 1,
  }));
  const writeArtifact = vi.fn(async () => undefined);
  const prepareStore = vi.fn(async () => ({ writeArtifact }));
  const validateTrial = vi.fn(() => true);
  return { runTrial, verifyAggregate, prepareStore, validateTrial, writeArtifact, ...overrides };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function completeArtifact(trialId, index) {
  const artifact = {
    schema_version: 'discord-mcp.activation-trial.v2',
    host: 'claude-code',
    host_version: HOST_VERSION,
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
    readiness: { install: 'ready', setup: 'ready', client: 'ready', first_request: 'ready' },
    terminal_status: 'passed',
    evidence: { apply: 'completed', guild_blueprint_evidence: 'verified' },
    digests: {
      build: digest('build'),
      evidence: digest(`evidence-${index}`),
      session: digest(`session-${index}`),
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
      before_digest: digest('baseline'),
      after_digest: digest('baseline'),
    },
  };
  return {
    ...artifact,
    attestation: {
      schema_version: ACTIVATION_ATTESTATION_REF_SCHEMA,
      envelope_digest: digest(`envelope-${index}`),
      trial_digest: activationTrialDigest(artifact),
    },
  };
}

describe('Claude Code activation campaign', () => {
  it('parses the exact release, run, host, commit, guild, and campaign confirmation', () => {
    expect(parseClaudeCodeActivationCampaignArgs(argv())).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      hostVersion: HOST_VERSION,
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
    });
  });

  it.each([
    [...argv(), '--guild', GUILD_ID],
    argv().slice(0, -2),
    ['--unknown', 'value'],
    argv({ confirmation: `${confirmation()}-wrong` }),
    argv({ guildId: '1533719084636700999', confirmation: undefined }),
  ])('rejects invalid campaign arguments', (input) => {
    expect(() => parseClaudeCodeActivationCampaignArgs(input)).toThrow(/arguments are invalid/);
  });

  it('runs exactly the fixed three live Claude trials and publishes a verified bundle', async () => {
    const injected = seams();
    const result = await runClaudeCodeActivationCampaign(request(), injected);

    expect(result).toEqual({
      schema_version: CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: {
        schema_version: 'discord-mcp.activation-trials-verifier.v1',
        verified: true,
        host_count: 1,
      },
    });
    expect(injected.runTrial).toHaveBeenCalledTimes(3);
    expect(injected.runTrial.mock.calls.map(([input]) => input.trialId)).toEqual([
      'claude-code-activation-01',
      'claude-code-activation-02',
      'claude-code-activation-03',
    ]);
    for (const [input] of injected.runTrial.mock.calls) {
      expect(input).toMatchObject({
        release: RELEASE,
        runId: RUN_ID,
        hostVersion: HOST_VERSION,
        sourceCommit: SOURCE_COMMIT,
        executionMode: 'live',
        token: TOKEN,
        target: {
          guildId: GUILD_ID,
          botId: '1533719084636700773',
          controlled: true,
          callerOwned: true,
        },
      });
      expect(input.operatorConfirmation).toBe(
        `APPROVE_CLAUDE_CODE_ACTIVATION:${RELEASE}:${input.trialId}`,
      );
      expect(input.writeApproval).toBe(
        `APPROVE_CLAUDE_CODE_ACTIVATION_WRITE:${RELEASE}:${input.trialId}`,
      );
    }
    expect(injected.prepareStore).toHaveBeenCalledWith({
      cwd: resolve('.'),
      artifactRoot: ARTIFACT_ROOT,
      runId: RUN_ID,
    });
    expect(injected.verifyAggregate).toHaveBeenCalledWith({
      trials: expect.any(Array),
      expectedHosts: ['claude-code'],
      expectedRelease: RELEASE,
      expectedCommit: SOURCE_COMMIT,
    });
    expect(injected.writeArtifact).toHaveBeenCalledTimes(4);
    expect(injected.writeArtifact).toHaveBeenLastCalledWith(
      'results/activation-trials-bundle.json',
      expect.objectContaining({ schema_version: 'discord-mcp.activation-trials-bundle.v1' }),
    );
  });

  it('completes host authentication preflight before reserving the artifact run', async () => {
    const order = [];
    const writeArtifact = vi.fn(async () => undefined);
    const injected = seams({
      preflight: vi.fn(async () => {
        order.push('preflight');
      }),
      prepareStore: vi.fn(async () => {
        order.push('store');
        return { writeArtifact };
      }),
      writeArtifact,
    });

    await expect(runClaudeCodeActivationCampaign(request(), injected)).resolves.toMatchObject({
      ok: true,
    });

    expect(order).toEqual(['preflight', 'store']);
    expect(injected.preflight).toHaveBeenCalledOnce();
  });

  it('fails missing default Claude authentication before reserving the artifact run', async () => {
    const prepareStore = vi.fn();
    vi.stubEnv('DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT', ARTIFACT_ROOT);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      await expect(runClaudeCodeActivationCampaign(request(), { prepareStore })).rejects.toThrow(
        /ANTHROPIC_API_KEY preflight failed/,
      );
      expect(prepareStore).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts complete artifacts through assertActivationTrialArtifact', async () => {
    let index = 0;
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: completeArtifact(trialId, index++),
    }));
    const injected = seams({ runTrial, validateTrial: undefined });
    await expect(runClaudeCodeActivationCampaign(request(), injected)).resolves.toMatchObject({
      ok: true,
    });
    expect(runTrial).toHaveBeenCalledTimes(3);
  });

  it('stops after a failed trial and never aggregates or publishes a partial bundle', async () => {
    const runTrial = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, artifact: fixtureArtifact('claude-code-activation-01') })
      .mockResolvedValueOnce({
        ok: false,
        artifact: fixtureArtifact('claude-code-activation-02', { result: 'failed' }),
      });
    const injected = seams({ runTrial });

    const result = await runClaudeCodeActivationCampaign(request(), injected);

    expect(result).toMatchObject({
      schema_version: CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: false,
      completed_trials: 1,
      failed_trial: { trial_id: 'claude-code-activation-02', result: 'failed' },
    });
    expect(runTrial).toHaveBeenCalledTimes(2);
    expect(injected.verifyAggregate).not.toHaveBeenCalled();
    expect(injected.writeArtifact).toHaveBeenCalledTimes(2);
    expect(injected.writeArtifact).toHaveBeenLastCalledWith(
      'results/claude-code-activation-02.json',
      expect.objectContaining({ result: 'failed' }),
    );
  });

  it.each([
    { host: 'codex' },
    { host_version: '9.9.9' },
    { release: '9.9.9' },
    { source_commit: 'a'.repeat(40) },
    { trial_id: 'claude-code-activation-99' },
    { execution_mode: 'test' },
  ])('fails closed on wrong trial identity (%o)', async (identity) => {
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: true,
      artifact: fixtureArtifact(trialId, identity),
    }));
    const injected = seams({ runTrial });

    await expect(runClaudeCodeActivationCampaign(request(), injected)).rejects.toThrow(
      /before producing a valid artifact/,
    );
    expect(runTrial).toHaveBeenCalledOnce();
    expect(injected.verifyAggregate).not.toHaveBeenCalled();
    expect(injected.writeArtifact).toHaveBeenCalledWith(
      'results/claude-code-activation-01.failure.json',
      expect.objectContaining({ result: 'failed' }),
    );
  });

  it('fails closed on contradictory or secret-bearing runner results', async () => {
    const runTrial = vi.fn(async ({ trialId }) => ({
      ok: false,
      artifact: fixtureArtifact(trialId, { result: 'passed', note: TOKEN }),
    }));
    const injected = seams({ runTrial });

    await expect(runClaudeCodeActivationCampaign(request(), injected)).rejects.toThrow(
      /before producing a valid artifact/,
    );
    expect(injected.writeArtifact).toHaveBeenCalledWith(
      'results/claude-code-activation-01.failure.json',
      expect.not.objectContaining({ note: TOKEN }),
    );
  });

  it('does not publish a bundle when the aggregate seam does not verify', async () => {
    const injected = seams({
      verifyAggregate: vi.fn(() => ({
        schema_version: 'discord-mcp.activation-trials-verifier.v1',
        verified: false,
      })),
    });
    await expect(runClaudeCodeActivationCampaign(request(), injected)).rejects.toThrow(
      /public verification failed/,
    );
    expect(injected.runTrial).toHaveBeenCalledTimes(3);
    expect(injected.writeArtifact).toHaveBeenCalledTimes(3);
    expect(injected.writeArtifact).not.toHaveBeenCalledWith(
      'results/activation-trials-bundle.json',
      expect.anything(),
    );
  });

  it('keeps CLI success output secret-free and emits a generic failure envelope', async () => {
    const runCampaign = vi.fn(async () => ({
      schema_version: CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
      ok: true,
      bundle_relative_path: `runs/${RUN_ID}/results/activation-trials-bundle.json`,
      public_aggregate: { verified: true },
    }));
    const successWrites = [];
    const successCode = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}`,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => successWrites.push(value) },
      runCampaign,
    });
    expect(successCode).toBe(0);
    expect(runCampaign).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    expect(successWrites.join('')).not.toContain(TOKEN);

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
        schema_version: CLAUDE_CODE_ACTIVATION_CAMPAIGN_SCHEMA,
        ok: false,
        error: 'activation campaign failed',
      })}\n`,
    );
    expect(runCampaign).toHaveBeenCalledOnce();

    const secretWrites = [];
    const secretCode = await main({
      argv: argv(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: TOKEN,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
      },
      stdout: { write: (value) => secretWrites.push(value) },
      runCampaign: async () => ({ ok: true, token: TOKEN }),
    });
    expect(secretCode).toBe(1);
    expect(secretWrites.join('')).not.toContain(TOKEN);
    expect(JSON.parse(secretWrites.join(''))).toMatchObject({ ok: false });
  });
});
