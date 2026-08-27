import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createCodexActivationLiveAdapter } from './codex-activation-live-adapter.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const THREAD_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'x'.repeat(60);
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PLAN_ID = hash('plan');
const BLUEPRINT_ID = hash('blueprint');
const APPROVAL_ID = hash('approval');

function output(tool, arguments_, result) {
  return [
    { type: 'thread.started', thread_id: THREAD_ID },
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: `${tool}-call`,
        name: tool,
        arguments: arguments_,
        result: { structured_content: result },
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join('\n');
}

function hostResult(stdout) {
  return {
    stdout,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: false,
    truncated: false,
  };
}

function plan() {
  return {
    status: 'ready',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    snapshot_id: hash('snapshot'),
    approval_id: APPROVAL_ID,
    plan_ref: PLAN_REF,
    plan_token: 'private-plan-token',
    blueprint: { components_v2: { publications: [] } },
    operations: [{ operation_id: 'fixture:operation' }],
    blockers: [],
  };
}

function applyResult() {
  return {
    status: 'complete',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    progress: { completed_total: 1, remaining: 0 },
    evidence: {
      bindings: {
        roles: {},
        categories: {},
        channels: {},
        automod_rules: {},
        publications: {},
      },
    },
    error: null,
  };
}

function evidenceResult() {
  return {
    status: 'verified',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    evidence_id: hash('evidence'),
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      remaining_operations: [],
      blockers: [],
    },
  };
}

describe('Codex activation live adapter', () => {
  it('uses one registered isolated session for preview, apply, and separate evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-codex-activation-live-'));
    const installRoot = join(root, 'install');
    const stateDirectory = join(root, 'state');
    const privateHome = join(root, 'private-codex-home');
    await Promise.all([
      mkdir(installRoot, { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
      mkdir(privateHome, { recursive: true }),
    ]);
    const p = plan();
    const responses = [
      hostResult('codex-cli 0.147.0\n'),
      hostResult(
        output(
          'build_discord_server',
          { request: 'Dựng cho tôi một server gaming chuyên nghiệp.' },
          p,
        ),
      ),
      hostResult(
        output(
          'guild_blueprint_apply',
          {
            guild_id: GUILD_ID,
            expected_bot_id: BOT_ID,
            approval_id: APPROVAL_ID,
            plan_ref: PLAN_REF,
            __confirm: true,
          },
          applyResult(),
        ),
      ),
      hostResult(
        output(
          'guild_blueprint_evidence',
          { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID },
          evidenceResult(),
        ),
      ),
    ];
    let registered = null;
    const runProcess = vi.fn(async ({ args }) => {
      expect(registered).not.toBeNull();
      if (responses.length === 2) {
        expect(args.join('\n')).toContain('["guild_blueprint_apply"]');
        expect(args.at(-1)).toContain('then stop immediately after its result');
      }
      if (responses.length === 1) {
        expect(args.join('\n')).toContain('["guild_blueprint_evidence"]');
        expect(args.at(-1)).toContain('Do not call guild_blueprint_apply');
      }
      return responses.shift();
    });
    const activityValidator = vi.fn();
    const adapter = createCodexActivationLiveAdapter({
      environment: {
        PATH: process.env.PATH,
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: join(root, 'artifacts'),
      },
      verifyRuntimePackage: async () => ({
        cliPath: join(installRoot, 'cli.js'),
        corePath: join(installRoot, 'core.js'),
      }),
      resolveLauncher: async () => {
        expect(registered).not.toBeNull();
        return { command: 'codex', prefix_args: [], kind: 'binary' };
      },
      attestLauncher: async (launcher) => ({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: launcher.kind,
        digest: hash('launcher'),
      }),
      runProcess,
      prepareCodexHome: async () => ({
        path: privateHome,
        cleanup: () => rm(privateHome, { recursive: true, force: true }),
      }),
      loadActivityValidator: async () => activityValidator,
      validatePlanResult: (value) => value,
      validateApplyResult: (value) => value,
      summarizeActivityEvidence: () => ({
        evidence_id: hash('evidence'),
        evidence_body: {
          schema_version: 'guild_blueprint_activity_evidence.v1',
          recorded_at: '2026-08-14T00:00:00.000Z',
          plan_id: PLAN_ID,
          blueprint_id: BLUEPRINT_ID,
          target: { guild_id: GUILD_ID, bot_id: BOT_ID },
          blueprint: p.blueprint,
          initial_operation_count: 1,
          plan_invariants: {},
          observed: {},
        },
      }),
      resolvePublicationTargets: () => [],
    });
    try {
      const target = { guildId: GUILD_ID, botId: BOT_ID };
      const binding = { guildId: GUILD_ID, botId: BOT_ID };
      const session = await adapter.launch({
        release: '0.22.0',
        hostVersion: '0.147.0',
        target,
        installRoot,
        install: { cliDigest: hash('cli'), coreDigest: hash('core') },
        stateDirectory,
        env: { DISCORD_TOKEN: TOKEN },
        binding,
        registerSession(value) {
          registered = value;
        },
      });
      expect(session).toMatchObject({
        clientReady: true,
        firstRequest: true,
        isolated: true,
        threadId: THREAD_ID,
      });
      expect(session.sessionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

      const applied = await adapter.apply({ session, target, binding });
      expect(applied).toMatchObject({ status: 'complete', binding });
      const evidence = await adapter.evidence({ session, target, binding, apply: applied });
      expect(evidence).toMatchObject({
        status: 'verified',
        binding,
        activityEvidence: { evidence_id: hash('evidence') },
      });
      await expect(
        adapter.validateActivityEvidence(evidence.activityEvidence, { session }),
      ).resolves.toBe(true);
      expect(activityValidator).toHaveBeenCalledTimes(2);
      await expect(adapter.closeSession({ session })).resolves.toEqual({
        settled: true,
        closed: true,
        launcherVerified: true,
      });
      expect(runProcess).toHaveBeenCalledTimes(4);
      expect(responses).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('holds the controlled-guild lock until exact baseline verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-codex-activation-baseline-'));
    const release = vi.fn();
    const baseline = {
      guild_id: GUILD_ID,
      bot_id: BOT_ID,
      fingerprint: hash('baseline'),
    };
    const adapter = createCodexActivationLiveAdapter({
      environment: { DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: join(root, 'artifacts') },
      verifyRuntimePackage: async () => ({}),
      readBaseline: async () => baseline,
      acquireLock: async () => ({ release }),
      createRuntime: () => ({ readSnapshot: vi.fn(), rest: {}, loadCheckpoint: vi.fn() }),
      verifyBaselineRecord: async () => ({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: baseline.fingerprint,
      }),
    });
    try {
      const capture = await adapter.captureBaseline({
        target: { guildId: GUILD_ID, botId: BOT_ID },
        token: TOKEN,
        runId: 'activation-run-001',
        sourceCommit: 'a'.repeat(40),
      });
      expect(capture).toEqual({ beforeDigest: baseline.fingerprint });
      expect(release).not.toHaveBeenCalled();
      await expect(
        adapter.verifyBaseline({
          target: { guildId: '1537363439452823645', botId: BOT_ID },
          baseline: capture,
        }),
      ).rejects.toThrow(/target binding/);
      expect(release).not.toHaveBeenCalled();
      await expect(
        adapter.restoreBaseline({
          target: { guildId: GUILD_ID, botId: BOT_ID },
          baseline: capture,
        }),
      ).resolves.toEqual({ restored: true });
      expect(release).not.toHaveBeenCalled();
      await expect(
        adapter.verifyBaseline({
          target: { guildId: GUILD_ID, botId: BOT_ID },
          baseline: capture,
        }),
      ).resolves.toEqual({
        exact: true,
        restored: true,
        afterDigest: baseline.fingerprint,
      });
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
