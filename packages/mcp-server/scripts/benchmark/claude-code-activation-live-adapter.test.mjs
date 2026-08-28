import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { createClaudeCodeActivationLiveAdapter } from './claude-code-activation-live-adapter.mjs';
import { buildClaudeCodeMcpConfig } from './claude-code-driver.mjs';
import { CLAUDE_CODE_TOOLS } from './claude-code-live-eval.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'Bot caller-owned-token';
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const PLAN_ID = digest('plan');
const BLUEPRINT_ID = digest('blueprint');
const APPROVAL_ID = digest('approval');
const DRIVER_PATH = fileURLToPath(new URL('./claude-code-driver.mjs', import.meta.url));

function stream(tool, input, result) {
  const callId = `${tool}-call`;
  return [
    { type: 'system', subtype: 'init', session_id: SESSION_ID, claude_code_version: '2.1.228' },
    {
      type: 'assistant',
      session_id: SESSION_ID,
      message: { content: [{ type: 'tool_use', id: callId, name: tool, input }] },
    },
    {
      type: 'user',
      session_id: SESSION_ID,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: [{ type: 'text', text: JSON.stringify({ structured_content: result }) }],
          },
        ],
      },
      tool_use_result: { structuredContent: result },
    },
    { type: 'result', subtype: 'success', is_error: false, session_id: SESSION_ID },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

const hostResult = (stdout) => ({
  stdout,
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  spawnError: false,
  truncated: false,
});

function plan() {
  return {
    status: 'ready',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    approval_id: APPROVAL_ID,
    plan_ref: PLAN_REF,
    blueprint: { components_v2: { publications: [] } },
  };
}

function apply() {
  return {
    status: 'complete',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    progress: { completed_total: 1, remaining: 0 },
    evidence: {
      bindings: { roles: {}, categories: {}, channels: {}, automod_rules: {}, publications: {} },
    },
    error: null,
  };
}

function evidence() {
  return {
    status: 'verified',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    evidence_id: digest('evidence'),
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      remaining_operations: [],
      blockers: [],
    },
  };
}

async function fixture({ mismatch = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude activation adapter '));
  const stateDirectory = resolve(root, 'durable-state');
  const guidedConfigPath = resolve(root, 'guided-mcp.json');
  const privateRoot = resolve(root, 'private-root');
  const settingsPath = resolve(privateRoot, 'settings.json');
  const mcpConfigPath = resolve(privateRoot, 'mcp.json');
  const target = { guildId: GUILD_ID, botId: BOT_ID };
  const config = buildClaudeCodeMcpConfig({
    nodePath: process.execPath,
    cliPath: DRIVER_PATH,
    target,
    stateDirectory,
    mode: 'allow',
  });
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await writeFile(guidedConfigPath, JSON.stringify(mismatch ? { wrong: true } : config));
  await writeFile(mcpConfigPath, JSON.stringify(config));
  const cleanup = vi.fn(async () => rm(privateRoot, { recursive: true, force: true }));
  const privateState = {
    path: privateRoot,
    settingsPath,
    mcpConfigPath,
    config,
    environment: {
      PATH: process.env.PATH,
      DISCORD_TOKEN: TOKEN,
      CLAUDE_CONFIG_DIR: privateRoot,
    },
    cleanup,
  };
  return { root, stateDirectory, guidedConfigPath, target, privateState, cleanup };
}

describe('Claude Code activation live adapter', () => {
  it('uses exact private settings/config argv and exact child environment for every phase', async () => {
    const fixtureState = await fixture();
    const responses = [
      hostResult('Claude Code 2.1.228\n'),
      hostResult(stream(CLAUDE_CODE_TOOLS.initial, { request: 'build a gaming server' }, plan())),
      hostResult(
        stream(
          CLAUDE_CODE_TOOLS.apply,
          {
            guild_id: GUILD_ID,
            expected_bot_id: BOT_ID,
            approval_id: APPROVAL_ID,
            plan_ref: PLAN_REF,
            __confirm: true,
          },
          apply(),
        ),
      ),
      hostResult(
        stream(
          CLAUDE_CODE_TOOLS.evidence,
          { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID },
          evidence(),
        ),
      ),
    ];
    const invocations = [];
    const adapter = createClaudeCodeActivationLiveAdapter({
      environment: {
        PATH: 'safe-path',
        ANTHROPIC_API_KEY: 'ambient-secret',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret-too',
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: resolve(fixtureState.root, 'artifacts'),
      },
      preparePrivateState: async (input) => {
        expect(input).toMatchObject({
          target: fixtureState.target,
          cliPath: DRIVER_PATH,
          nodePath: process.execPath,
          discordToken: TOKEN,
          stateDirectory: fixtureState.stateDirectory,
          mode: 'allow',
        });
        return fixtureState.privateState;
      },
      verifyRuntimePackage: async () => ({ cliPath: DRIVER_PATH, corePath: DRIVER_PATH }),
      resolveLauncher: async () => ({ command: 'claude', prefix_args: [], kind: 'binary' }),
      attestLauncher: async (launcher) => ({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: launcher.kind,
        digest: digest('launcher'),
      }),
      runProcess: vi.fn(async (input) => {
        expect(input.env).toEqual(fixtureState.privateState.environment);
        expect(input.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(input.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        invocations.push(input.args);
        return responses.shift();
      }),
      initialRequest: 'build a gaming server',
      loadActivityValidator: async () => () => {},
      verifyStateDirectoryPath: async (value) => value,
      validatePlanResult: () => {},
      validateApplyResult: () => {},
      summarizeActivityEvidence: () => ({ evidence_id: digest('evidence'), evidence_body: {} }),
      resolvePublicationTargets: () => [],
    });
    try {
      const binding = fixtureState.target;
      const session = await adapter.launch({
        release: '0.25.0',
        hostVersion: '2.1.228',
        target: fixtureState.target,
        installRoot: fixtureState.root,
        install: { cliDigest: digest('cli'), coreDigest: digest('core') },
        stateDirectory: fixtureState.stateDirectory,
        configPath: fixtureState.guidedConfigPath,
        env: { DISCORD_TOKEN: TOKEN },
        binding,
        registerSession: () => {},
      });
      await adapter.apply({ session, target: fixtureState.target, binding });
      await adapter.evidence({
        session,
        target: fixtureState.target,
        binding,
        apply: session.lastApply,
      });
      expect(invocations).toHaveLength(4);
      for (const args of invocations.slice(1)) {
        expect(args).toContain(fixtureState.privateState.settingsPath);
        expect(args).toContain(fixtureState.privateState.mcpConfigPath);
        expect(args).not.toContain(fixtureState.guidedConfigPath);
      }
      await adapter.closeSession({ session });
      expect(fixtureState.cleanup).toHaveBeenCalledTimes(1);
      await expect(access(fixtureState.stateDirectory)).resolves.toBeUndefined();
    } finally {
      await rm(fixtureState.root, { recursive: true, force: true });
    }
  });

  it('rejects a divergent guided config before launching Claude and cleans private state', async () => {
    const fixtureState = await fixture({ mismatch: true });
    const runProcess = vi.fn();
    const adapter = createClaudeCodeActivationLiveAdapter({
      environment: {
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: resolve(fixtureState.root, 'artifacts'),
      },
      preparePrivateState: async () => fixtureState.privateState,
      verifyRuntimePackage: async () => ({ cliPath: DRIVER_PATH, corePath: DRIVER_PATH }),
      runProcess,
      resolveLauncher: async () => ({ command: 'claude', prefix_args: [], kind: 'binary' }),
      attestLauncher: async (launcher) => ({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: launcher.kind,
        digest: digest('launcher'),
      }),
      loadActivityValidator: async () => () => {},
      verifyStateDirectoryPath: async (value) => value,
    });
    try {
      await expect(
        adapter.launch({
          release: '0.25.0',
          hostVersion: '2.1.228',
          target: fixtureState.target,
          installRoot: fixtureState.root,
          install: { cliDigest: digest('cli'), coreDigest: digest('core') },
          stateDirectory: fixtureState.stateDirectory,
          configPath: fixtureState.guidedConfigPath,
          env: { DISCORD_TOKEN: TOKEN },
          binding: fixtureState.target,
          registerSession: () => {},
        }),
      ).rejects.toThrow(/guided config|MCP config/);
      expect(runProcess).not.toHaveBeenCalled();
      expect(fixtureState.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await rm(fixtureState.root, { recursive: true, force: true });
    }
  });
});
