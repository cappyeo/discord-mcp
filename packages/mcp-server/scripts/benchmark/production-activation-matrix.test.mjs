import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import {
  main,
  PRODUCTION_ACTIVATION_MATRIX_CONFIRMATION_PREFIX,
  PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
  parseProductionActivationMatrixArgs,
  preflightProductionActivationHosts,
  productionActivationMatrixConfirmation,
  productionActivationRunIds,
  runProductionActivationMatrix,
  validateProductionActivationMatrixRequest,
} from './production-activation-matrix.mjs';
import {
  ACTIVATION_VERIFIER_SCHEMA,
  PRODUCTION_ACTIVATION_HOSTS,
} from './verify-activation-trials.mjs';

const RELEASE = '0.25.0';
const MATRIX_RUN_ID = 'five-host-live-001';
const SOURCE_COMMIT = 'a'.repeat(40);
const GUILD_ID = CONTROLLED_GUILD_IDS[0];
const TOKEN = 'matrix-discord-integrity-key';
const ARTIFACT_ROOT = join(tmpdir(), 'discord-mcp-production-activation-matrix');
const BUILD = `sha256:${createHash('sha256').update('public-package').digest('hex')}`;
const HOST_VERSIONS = Object.fromEntries(
  PRODUCTION_ACTIVATION_HOSTS.map((host) => [host, '1.0.0']),
);

function confirmation() {
  return productionActivationMatrixConfirmation({
    release: RELEASE,
    runId: MATRIX_RUN_ID,
    guildId: GUILD_ID,
    sourceCommit: SOURCE_COMMIT,
  });
}

function request(overrides = {}) {
  return {
    release: RELEASE,
    runId: MATRIX_RUN_ID,
    sourceCommit: SOURCE_COMMIT,
    guildId: GUILD_ID,
    confirmation: confirmation(),
    token: TOKEN,
    cwd: process.cwd(),
    artifactRoot: ARTIFACT_ROOT,
    hostVersions: { ...HOST_VERSIONS },
    ...overrides,
  };
}

function argv(overrides = {}) {
  const hostVersions = { ...HOST_VERSIONS, ...overrides.hostVersions };
  const value = {
    release: RELEASE,
    runId: MATRIX_RUN_ID,
    sourceCommit: SOURCE_COMMIT,
    guildId: GUILD_ID,
    confirmation: confirmation(),
    ...overrides,
  };
  return [
    '--release',
    value.release,
    '--run-id',
    value.runId,
    '--source-commit',
    value.sourceCommit,
    '--guild',
    value.guildId,
    '--confirmation',
    value.confirmation,
    ...PRODUCTION_ACTIVATION_HOSTS.flatMap((host) => [`--${host}-version`, hostVersions[host]]),
  ];
}

function campaignResult(host, runId, buildDigest = BUILD) {
  return {
    schema_version: `discord-mcp.${host}-activation-campaign.v1`,
    ok: true,
    bundle_relative_path: `runs/${runId}/results/activation-trials-bundle.json`,
    public_aggregate: {
      schema_version: ACTIVATION_VERIFIER_SCHEMA,
      artifact_schema: 'discord-mcp.activation-trial.v3',
      verified: true,
      release: RELEASE,
      source_commit: SOURCE_COMMIT,
      build_digest: buildDigest,
      host_count: 1,
      hosts: [{ host, trial_count: 3 }],
    },
  };
}

function matrixResult(overrides = {}) {
  return {
    schema_version: ACTIVATION_VERIFIER_SCHEMA,
    artifact_schema: 'discord-mcp.activation-trial.v3',
    verified: true,
    release: RELEASE,
    source_commit: SOURCE_COMMIT,
    build_digest: BUILD,
    host_count: 5,
    hosts: PRODUCTION_ACTIVATION_HOSTS.map((host) => ({ host, trial_count: 3 })),
    ...overrides,
  };
}

function campaignMocks(handler) {
  return Object.fromEntries(
    PRODUCTION_ACTIVATION_HOSTS.map((host) => [
      host,
      vi.fn((options, dependencies) => handler(host, options, dependencies)),
    ]),
  );
}

describe('production activation matrix orchestrator', () => {
  it('preflights all credentials, Codex auth, and exact host versions as one local gate', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'discord-mcp-matrix-codex-'));
    try {
      await writeFile(join(codexHome, 'auth.json'), '{}', { mode: 0o600 });
      const environment = {
        ANTHROPIC_API_KEY: 'anthropic-test-key',
        GEMINI_API_KEY: 'gemini-test-key',
        CURSOR_API_KEY: 'cursor-test-key',
        XAI_API_KEY: 'xai-test-key',
        CODEX_HOME: codexHome,
        PATH: process.env.PATH,
      };
      const versionProbes = Object.fromEntries(
        PRODUCTION_ACTIVATION_HOSTS.map((host) => [
          host,
          {
            resolveLauncher: vi.fn(async () => ({ command: host, prefix_args: [] })),
            runProcess: vi.fn(async (options) => {
              expect(options.args).toEqual(['--version']);
              expect(options.cwd).toBe(process.cwd());
              expect(options.env).toEqual({ PATH: process.env.PATH });
              return {
                stdout: `${host} ${HOST_VERSIONS[host]}`,
                exitCode: 0,
                signal: null,
                timedOut: false,
                aborted: false,
                spawnError: false,
                truncated: false,
              };
            }),
          },
        ]),
      );
      const preflightRequest = {
        environment,
        hostVersions: HOST_VERSIONS,
        cwd: process.cwd(),
      };
      await expect(
        preflightProductionActivationHosts(preflightRequest, { versionProbes }),
      ).resolves.toBe(true);
      for (const probe of Object.values(versionProbes)) {
        expect(probe.resolveLauncher).toHaveBeenCalledWith({
          environment: { PATH: process.env.PATH },
        });
      }
      await expect(
        preflightProductionActivationHosts(
          { ...preflightRequest, environment: { ...environment, XAI_API_KEY: '' } },
          { versionProbes },
        ),
      ).rejects.toThrow(/XAI_API_KEY preflight/);
      expect(
        Object.values(versionProbes).every((probe) => probe.runProcess.mock.calls.length === 1),
      ).toBe(true);
      versionProbes['grok-cli'].runProcess.mockResolvedValueOnce({
        stdout: 'grok 9.9.9',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: false,
        truncated: false,
      });
      await expect(
        preflightProductionActivationHosts(preflightRequest, { versionProbes }),
      ).rejects.toThrow(/host version preflight/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('binds one explicit approval to the exact release, matrix run, guild, bot, and commit', () => {
    expect(confirmation()).toBe(
      `${PRODUCTION_ACTIVATION_MATRIX_CONFIRMATION_PREFIX}${RELEASE}:${MATRIX_RUN_ID}:${GUILD_ID}:${CONTROLLED_BOT_ID}:${SOURCE_COMMIT}`,
    );
    expect(parseProductionActivationMatrixArgs(argv())).toEqual({
      release: RELEASE,
      runId: MATRIX_RUN_ID,
      sourceCommit: SOURCE_COMMIT,
      guildId: GUILD_ID,
      confirmation: confirmation(),
      hostVersions: HOST_VERSIONS,
    });
    expect(
      validateProductionActivationMatrixRequest(request({ token: `Bot ${TOKEN}` })).token,
    ).toBe(TOKEN);
    expect(() =>
      parseProductionActivationMatrixArgs(argv({ confirmation: `${confirmation()}-drift` })),
    ).toThrow(/arguments/);
    expect(() =>
      validateProductionActivationMatrixRequest(request({ confirmation: 'wrong' })),
    ).toThrow(/request/);
  });

  it('preflights every host before running five campaigns sequentially and then verifies 15 trials', async () => {
    const events = [];
    const runIds = productionActivationRunIds(MATRIX_RUN_ID);
    const runCampaigns = campaignMocks(async (host, options, dependencies) => {
      events.push(`campaign:${host}`);
      expect(events[0]).toBe('preflight');
      expect(options).toMatchObject({
        release: RELEASE,
        runId: runIds[host],
        hostVersion: HOST_VERSIONS[host],
        sourceCommit: SOURCE_COMMIT,
        guildId: GUILD_ID,
        token: TOKEN,
        cwd: process.cwd(),
        artifactRoot: ARTIFACT_ROOT,
      });
      expect(options.confirmation).toBe(
        `APPROVE_${host.replaceAll('-', '_').toUpperCase()}_ACTIVATION_CAMPAIGN:${RELEASE}:${runIds[host]}:${GUILD_ID}`,
      );
      await expect(dependencies.preflight()).resolves.toBe(true);
      return campaignResult(host, runIds[host]);
    });
    const verifyMatrix = vi.fn(async (options) => {
      events.push('verify');
      expect(events.slice(1, -1)).toEqual(
        PRODUCTION_ACTIVATION_HOSTS.map((host) => `campaign:${host}`),
      );
      expect(options).toMatchObject({
        integrityKey: TOKEN,
        expectedBinding: { guildId: GUILD_ID, botId: CONTROLLED_BOT_ID },
        expectedRelease: RELEASE,
        expectedCommit: SOURCE_COMMIT,
        expectedBuildDigest: BUILD,
      });
      expect(Object.keys(options.campaigns)).toEqual(PRODUCTION_ACTIVATION_HOSTS);
      return matrixResult();
    });
    const result = await runProductionActivationMatrix(request(), {
      environment: {},
      preflight: async () => {
        events.push('preflight');
      },
      runCampaigns,
      verifyMatrix,
      validateActivityEvidence: () => true,
    });
    expect(events).toEqual([
      'preflight',
      ...PRODUCTION_ACTIVATION_HOSTS.map((host) => `campaign:${host}`),
      'verify',
    ]);
    expect(result).toEqual({
      schema_version: PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
      ok: true,
      matrix_run_id: MATRIX_RUN_ID,
      campaign_run_ids: runIds,
      public_aggregate: matrixResult(),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('performs all authentication preflight before the first campaign side effect', async () => {
    const runCampaigns = campaignMocks(async () => campaignResult('codex', 'unused'));
    const verifyMatrix = vi.fn();
    await expect(
      runProductionActivationMatrix(request(), {
        environment: {},
        preflight: async () => {
          throw new Error('host authentication unavailable');
        },
        runCampaigns,
        verifyMatrix,
        validateActivityEvidence: () => true,
      }),
    ).rejects.toThrow(/authentication unavailable/);
    expect(Object.values(runCampaigns).every((mock) => mock.mock.calls.length === 0)).toBe(true);
    expect(verifyMatrix).not.toHaveBeenCalled();
  });

  it('stops at the first host failure and never publishes a partial matrix', async () => {
    const calls = [];
    const runIds = productionActivationRunIds(MATRIX_RUN_ID);
    const runCampaigns = campaignMocks(async (host) => {
      calls.push(host);
      if (host === 'antigravity-cli') throw new Error('host campaign failed');
      return campaignResult(host, runIds[host]);
    });
    const verifyMatrix = vi.fn();
    await expect(
      runProductionActivationMatrix(request(), {
        environment: {},
        preflight: async () => true,
        runCampaigns,
        verifyMatrix,
        validateActivityEvidence: () => true,
      }),
    ).rejects.toThrow(/host campaign failed/);
    expect(calls).toEqual(['codex', 'claude-code', 'antigravity-cli']);
    expect(verifyMatrix).not.toHaveBeenCalled();
  });

  it('rejects package-build drift before launching the next host or final verifier', async () => {
    const calls = [];
    const runIds = productionActivationRunIds(MATRIX_RUN_ID);
    const runCampaigns = campaignMocks(async (host) => {
      calls.push(host);
      return campaignResult(
        host,
        runIds[host],
        host === 'claude-code' ? `sha256:${'f'.repeat(64)}` : BUILD,
      );
    });
    const verifyMatrix = vi.fn();
    await expect(
      runProductionActivationMatrix(request(), {
        environment: {},
        preflight: async () => true,
        runCampaigns,
        verifyMatrix,
        validateActivityEvidence: () => true,
      }),
    ).rejects.toThrow(/campaign result/);
    expect(calls).toEqual(['codex', 'claude-code']);
    expect(verifyMatrix).not.toHaveBeenCalled();
  });

  it('keeps the CLI boundary generic and secret-free on success and failure', async () => {
    const success = [];
    const output = {
      schema_version: PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
      ok: true,
      matrix_run_id: MATRIX_RUN_ID,
      campaign_run_ids: productionActivationRunIds(MATRIX_RUN_ID),
      public_aggregate: matrixResult(),
    };
    const runMatrix = vi.fn(async () => output);
    await expect(
      main({
        argv: argv(),
        environment: {
          DISCORD_TESTBOT_B_TOKEN: TOKEN,
          DISCORD_EXPECTED_BOT_ID: CONTROLLED_BOT_ID,
          DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
        },
        stdout: { write: (value) => success.push(value) },
        runMatrix,
        validateActivityEvidence: () => true,
      }),
    ).resolves.toBe(0);
    expect(runMatrix).toHaveBeenCalledOnce();
    expect(success).toEqual([`${JSON.stringify(output)}\n`]);
    expect(success.join('')).not.toContain(TOKEN);

    const failure = [];
    await expect(
      main({
        argv: argv(),
        environment: {
          DISCORD_TESTBOT_B_TOKEN: TOKEN,
          DISCORD_EXPECTED_BOT_ID: CONTROLLED_BOT_ID,
          DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: ARTIFACT_ROOT,
        },
        stdout: { write: (value) => failure.push(value) },
        runMatrix: async () => {
          throw new Error(`private failure ${TOKEN}`);
        },
        validateActivityEvidence: () => true,
      }),
    ).resolves.toBe(1);
    expect(failure).toEqual([
      `${JSON.stringify({
        schema_version: PRODUCTION_ACTIVATION_MATRIX_SCHEMA,
        ok: false,
        error: 'production activation matrix failed',
      })}\n`,
    ]);
    expect(failure.join('')).not.toContain(TOKEN);
  });
});
