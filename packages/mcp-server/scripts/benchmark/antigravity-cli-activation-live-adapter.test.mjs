import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createAntigravityCliActivationLiveAdapter } from './antigravity-cli-activation-live-adapter.mjs';
import { ANTIGRAVITY_CLI_LIFECYCLE_TOOLS } from './antigravity-cli-live-eval.mjs';
import { MCP_CAPTURE_SCHEMA } from './mcp-capture-proxy.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const CONVERSATION_ID = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const TOKEN = 'Bot caller-owned-token';
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const PLAN_ID = digest('plan');
const BLUEPRINT_ID = digest('blueprint');
const APPROVAL_ID = digest('approval');
const EVIDENCE_ID = digest('evidence');
const DRIVER_PATH = fileURLToPath(new URL('./antigravity-cli-driver.mjs', import.meta.url));

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
    progress: {
      initial_planned: 1,
      planned_this_call: 1,
      attempted_this_call: 1,
      completed_total: 1,
      remaining: 0,
      checkpoint_version: 2,
    },
    evidence: {
      bindings: { roles: {}, categories: {}, channels: {}, automod_rules: {}, publications: {} },
      activity: { evidence_id: EVIDENCE_ID },
    },
    error: null,
    next_action: 'done',
  };
}

function evidence() {
  return {
    status: 'verified',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    evidence_id: EVIDENCE_ID,
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      snapshot_unchanged: true,
      remaining_operations: [],
      blockers: [],
    },
  };
}

function receipt(data, phase) {
  const common = {
    schema_version: 'discord_mcp_blueprint_text_receipt.v1',
    phase,
    status: data.status,
    target: data.target,
  };
  let value;
  if (phase === 'plan') {
    value = {
      ...common,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      approval_id: data.approval_id,
      plan_ref: data.plan_ref,
    };
  } else if (phase === 'apply') {
    value = {
      ...common,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      progress: {
        completed_total: data.progress.completed_total,
        remaining: data.progress.remaining,
        checkpoint_version: data.progress.checkpoint_version,
      },
      error:
        data.error === null
          ? null
          : { code: data.error.code, retry_after_ms: data.error.retry_after_ms ?? null },
      evidence_id: data.evidence.activity?.evidence_id ?? null,
      next_action: data.next_action,
    };
  } else {
    value = {
      ...common,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      evidence_id: data.evidence_id,
      verification: {
        identity_verified: data.verification.identity_verified,
        guild_verified: data.verification.guild_verified,
        readback: data.verification.readback,
        snapshot_unchanged: data.verification.snapshot_unchanged,
        remaining: data.verification.remaining_operations.length,
        blockers: data.verification.blockers.length,
      },
    };
  }
  return `Result\nMCP_BLUEPRINT_RECEIPT ${JSON.stringify(value)}`;
}

function stream(tool, output) {
  return [
    {
      event: 'init',
      conversation_id: CONVERSATION_ID,
      init: { cwd: 'C:/fixture', tools: ['call_mcp_tool'], permission_mode: 'request-review' },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { name: tool, parameters: {}, output, error: null },
      },
    },
    {
      event: 'result',
      result: { conversation_id: CONVERSATION_ID, status: 'SUCCESS', response: 'Done.' },
    },
  ]
    .map((event) => JSON.stringify(event))
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

describe('Antigravity CLI activation live adapter', () => {
  it('runs plan, exact-conversation apply, and evidence through one private capture state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'antigravity activation adapter '));
    const stateDirectory = resolve(root, 'durable-state');
    const guidedConfigPath = resolve(root, 'guided-mcp.json');
    const privateRoot = resolve(root, 'private-root');
    const capturePath = resolve(privateRoot, 'capture.jsonl');
    const settingsPath = resolve(privateRoot, 'settings.json');
    const mcpConfigPath = resolve(privateRoot, 'mcp.json');
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(privateRoot, { recursive: true });
    await writeFile(guidedConfigPath, '{}');
    await writeFile(capturePath, '');
    const cleanup = vi.fn(async () => rm(privateRoot, { recursive: true, force: true }));
    const privateState = {
      path: privateRoot,
      settingsPath,
      mcpConfigPath,
      capturePath,
      captureCursor: 0,
      environment: {
        PATH: 'safe-path',
        GEMINI_API_KEY: 'ambient-model-key',
        DISCORD_TOKEN: TOKEN,
        HOME: privateRoot,
        USERPROFILE: privateRoot,
      },
      cleanup,
    };
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    const phases = [
      {
        tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
        args: { request: 'build a gaming server' },
        data: plan(),
        phase: 'plan',
      },
      {
        tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
        args: {
          guild_id: GUILD_ID,
          expected_bot_id: BOT_ID,
          approval_id: APPROVAL_ID,
          plan_ref: PLAN_REF,
          __confirm: true,
        },
        data: apply(),
        phase: 'apply',
      },
      {
        tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence,
        args: { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID },
        data: evidence(),
        phase: 'evidence',
      },
    ];
    let captureOrdinal = 0;
    const invocations = [];
    const adapter = createAntigravityCliActivationLiveAdapter({
      environment: {
        GEMINI_API_KEY: 'ambient-model-key',
        AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
        DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: resolve(root, 'artifacts'),
      },
      preparePrivateState: async (input) => {
        expect(input).toMatchObject({
          target,
          cliPath: DRIVER_PATH,
          nodePath: process.execPath,
          discordToken: TOKEN,
          stateDirectory,
          mode: 'allow',
        });
        return privateState;
      },
      verifyRuntimePackage: async () => ({ cliPath: DRIVER_PATH, corePath: DRIVER_PATH }),
      resolveLauncher: async () => ({ command: 'agy', prefix_args: [], kind: 'native' }),
      attestLauncher: async (launcher) => ({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: launcher.kind,
        digest: digest('launcher'),
      }),
      runProcess: vi.fn(async (input) => {
        expect(input.env).toEqual(privateState.environment);
        expect(input.env.GEMINI_API_KEY).toBe('ambient-model-key');
        expect(input.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        invocations.push(input.args);
        if (invocations.length === 1) return hostResult('Antigravity CLI 1.1.13\n');
        const next = phases.shift();
        captureOrdinal += 1;
        const text = receipt(next.data, next.phase);
        await writeFile(
          capturePath,
          `${JSON.stringify({
            schema_version: MCP_CAPTURE_SCHEMA,
            capture_id: `capture-${captureOrdinal}`,
            ordinal: captureOrdinal,
            tool_name: next.tool,
            arguments: next.args,
            result: {
              content: [{ type: 'text', text }],
              structuredContent: next.data,
              isError: false,
            },
          })}\n`,
          { encoding: 'utf8', flag: 'a' },
        );
        return hostResult(stream(next.tool, text));
      }),
      initialRequest: 'build a gaming server',
      loadActivityValidator: async () => () => {},
      verifyStateDirectoryPath: async (value) => value,
      validatePlanResult: () => {},
      validateApplyResult: () => {},
      summarizeActivityEvidence: () => ({ evidence_id: EVIDENCE_ID, evidence_body: {} }),
      resolvePublicationTargets: () => [],
    });
    try {
      const session = await adapter.launch({
        release: '0.24.0',
        hostVersion: '1.1.13',
        target,
        installRoot: root,
        install: { cliDigest: digest('cli'), coreDigest: digest('core') },
        stateDirectory,
        configPath: guidedConfigPath,
        env: { DISCORD_TOKEN: TOKEN },
        binding: target,
        registerSession: () => {},
      });
      expect(session.conversationId).toBe(CONVERSATION_ID);
      await adapter.apply({ session, target, binding: target });
      await adapter.evidence({ session, target, binding: target, apply: session.lastApply });
      expect(invocations).toHaveLength(4);
      expect(invocations[1]).not.toContain('--conversation');
      for (const args of invocations.slice(2)) {
        expect(args.slice(-2)).toEqual(['--conversation', CONVERSATION_ID]);
        expect(args).toContain('stream-json');
        expect(args).toContain('--sandbox');
      }
      expect(privateState.captureCursor).toBe(3);
      await adapter.closeSession({ session });
      expect(cleanup).toHaveBeenCalledTimes(1);
      await expect(access(stateDirectory)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
