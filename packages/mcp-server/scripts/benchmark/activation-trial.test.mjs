import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  canonicalActivationAttestationDigest,
  verifyActivationAttestation,
} from './activation-attestation.mjs';
import { runActivationTrial } from './activation-trial.mjs';

const RELEASE = '0.25.1';
const RUN_ID = 'activation-claude-code-20260814';
const TRIAL_ID = 'claude-code-activation-001';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const TOKEN = 'token-never-in-artifact';
const DIGEST = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const TARGET = { guildId: GUILD_ID, botId: BOT_ID, controlled: true, callerOwned: true };

function request() {
  return {
    release: RELEASE,
    runId: RUN_ID,
    trialId: TRIAL_ID,
    hostVersion: '1.0.0',
    sourceCommit: 'a'.repeat(40),
    target: TARGET,
    token: TOKEN,
    executionMode: 'test',
    maxDurationMs: 600_000,
    writeApproval: 'approved',
  };
}

function dependencies(persisted) {
  const binding = { guildId: GUILD_ID, botId: BOT_ID };
  const evidence = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    status: 'verified',
    evidence_id: DIGEST('activity-evidence'),
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
  };
  return {
    executionProvenance: {
      execution_mode: 'test',
      adapter_id: 'claude-code-test-fixture',
      abortable: true,
      package_source: 'test_fixture',
    },
    workspace: {
      async create() {
        return {
          root: 'test-root',
          home: 'test-home',
          installRoot: 'test-install',
          profileRoot: 'test-profile',
          profileEnvironmentKey: 'XDG_CONFIG_HOME',
          configPath: 'test-config.json',
          stateDirectory: 'test-state',
          cleanProfile: true,
        };
      },
      async readText() {
        return '{}';
      },
      async writeText() {},
      async remove() {
        return { removed: true, verified: true };
      },
    },
    async captureBaseline() {
      return { beforeDigest: DIGEST('baseline') };
    },
    async install() {
      return {
        sourceCommit: 'a'.repeat(40),
        cliDigest: DIGEST('cli'),
        coreDigest: DIGEST('core'),
        packageDigest: DIGEST('package'),
      };
    },
    async setup() {
      return {
        exitCode: 0,
        administratorWarning: false,
        config: '{}',
        binding,
        bindingVerified: true,
      };
    },
    async enableWrites() {
      return { config: '{"write":"approved"}' };
    },
    async launch() {
      return {
        binding,
        clientReady: true,
        firstRequest: true,
        isolated: true,
        launcherDigest: DIGEST('launcher'),
        sessionDigest: DIGEST('session'),
      };
    },
    async apply() {
      return { binding, status: 'complete' };
    },
    async evidence() {
      return { binding, status: 'verified', activityEvidence: evidence };
    },
    async validateActivityEvidence() {
      return true;
    },
    async closeSession() {
      return { settled: true };
    },
    async restoreBaseline() {
      return { restored: true };
    },
    async verifyBaseline() {
      return { restored: true, exact: true, afterDigest: DIGEST('baseline') };
    },
    async persistAttestation({ attestation, digest }) {
      persisted.attestation = attestation;
      persisted.digest = digest;
      return { persisted: true, digest };
    },
  };
}

describe('host-neutral activation trial runner', () => {
  it('preserves every safety gate for a Claude Code host artifact and attestation', async () => {
    const persisted = {};
    let clockValue = 0;
    const result = await runActivationTrial({
      request: request(),
      dependencies: dependencies(persisted),
      clock: { now: () => clockValue++ },
      host: 'claude-code',
      assertConfigReady: () => true,
      assertConfigWritable: () => true,
      buildLaunchEnvironment: ({ request: activationRequest }) => ({
        DISCORD_TOKEN: activationRequest.token,
        MCP_DRY_RUN: 'false',
        MCP_WRITE_MODE: 'allow',
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.artifact).toMatchObject({
      schema_version: 'discord-mcp.activation-trial.v3',
      host: 'claude-code',
      result: 'passed',
      terminal_status: 'passed',
      readiness: {
        install: 'ready',
        setup: 'ready',
        client: 'ready',
        first_request: 'ready',
      },
      evidence: { apply: 'completed', guild_blueprint_evidence: 'verified' },
      safety: {
        secret_free: true,
        caller_owned_bot: true,
        binding_verified: true,
        clean_profile: true,
        isolated_session: true,
        dangerous_permissions: false,
      },
      baseline: { restored: true, exact: true },
      digests: { launcher: DIGEST('launcher') },
    });
    expect(JSON.stringify(result.artifact)).not.toContain(TOKEN);
    expect(persisted.attestation).toMatchObject({
      schema_version: 'discord-mcp.activation-attestation.v2',
      host: 'claude-code',
      launcher_digest: DIGEST('launcher'),
      binding: { guild_id: GUILD_ID, bot_id: BOT_ID },
      profile: { kind: 'clean_temp', cleanup_verified: true, token_persisted: false },
      baseline: { restored: true, exact: true },
    });
    expect(persisted.digest).toBe(canonicalActivationAttestationDigest(persisted.attestation));
    expect(
      verifyActivationAttestation({
        attestation: persisted.attestation,
        integrityKey: TOKEN,
        validateActivityEvidence: () => true,
      }),
    ).toMatchObject({ host: 'claude-code' });
  });

  it.each([
    ['phaseTimeoutMs', 180_001],
    ['recoveryTimeoutMs', 30_001],
    ['cancellationTimeoutMs', 5_001],
  ])('rejects oversized %s before workspace side effects', async (name, value) => {
    const persisted = {};
    const testDependencies = dependencies(persisted);
    let workspaceCreates = 0;
    const createWorkspace = testDependencies.workspace.create;
    testDependencies.workspace.create = async (...args) => {
      workspaceCreates += 1;
      return createWorkspace(...args);
    };

    await expect(
      runActivationTrial({
        request: request(),
        dependencies: testDependencies,
        host: 'claude-code',
        limits: {
          phaseTimeoutMs: 180_000,
          recoveryTimeoutMs: 30_000,
          cancellationTimeoutMs: 5_000,
          [name]: value,
        },
        assertConfigReady: () => true,
        assertConfigWritable: () => true,
        buildLaunchEnvironment: () => ({}),
      }),
    ).rejects.toThrow('activation limits are invalid');
    expect(workspaceCreates).toBe(0);
  });

  it('fails closed for untrusted live dependencies before workspace side effects', async () => {
    const persisted = {};
    const liveDependencies = dependencies(persisted);
    let workspaceCreates = 0;
    const createWorkspace = liveDependencies.workspace.create;
    liveDependencies.workspace.create = async (...args) => {
      workspaceCreates += 1;
      return createWorkspace(...args);
    };
    liveDependencies.executionProvenance = {
      ...liveDependencies.executionProvenance,
      execution_mode: 'live',
      package_source: 'verified_npm_provenance',
    };

    await expect(
      runActivationTrial({
        request: { ...request(), executionMode: 'live' },
        dependencies: liveDependencies,
        host: 'claude-code',
        assertConfigReady: () => true,
        assertConfigWritable: () => true,
        buildLaunchEnvironment: () => ({}),
      }),
    ).rejects.toThrow('built-in audited dependency adapter');
    expect(workspaceCreates).toBe(0);
  });
});
