import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createCursorCliActivationLiveAdapter } from './cursor-cli-activation-live-adapter.mjs';
import { CURSOR_CLI_LIFECYCLE_TOOLS } from './cursor-cli-live-eval.mjs';
import { MCP_CAPTURE_SCHEMA } from './mcp-capture-proxy.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SESSION_ID = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const TOKEN = 'Bot caller-owned-token';
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const PLAN_ID = digest('plan');
const BLUEPRINT_ID = digest('blueprint');
const APPROVAL_ID = digest('approval');
const EVIDENCE_ID = digest('evidence');
const DRIVER_PATH = fileURLToPath(new URL('./cursor-cli-driver.mjs', import.meta.url));

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
      error: data.error,
      evidence_id: data.evidence.activity.evidence_id,
      next_action: data.next_action,
    };
  } else {
    value = {
      ...common,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      evidence_id: data.evidence_id,
      verification: {
        identity_verified: true,
        guild_verified: true,
        readback: 'match',
        snapshot_unchanged: true,
        remaining: 0,
        blockers: 0,
      },
    };
  }
  return `Result\nMCP_BLUEPRINT_RECEIPT ${JSON.stringify(value)}`;
}

function stream(tool, args, output, cwd) {
  const callId = 'call_01';
  const descriptor = {
    name: `discord-mcp-${tool}`,
    args,
    toolCallId: callId,
    providerIdentifier: 'discord-mcp',
    toolName: tool,
  };
  return [
    {
      type: 'system',
      subtype: 'init',
      cwd,
      session_id: SESSION_ID,
      model: 'cursor-small',
      permissionMode: 'default',
    },
    { type: 'user', session_id: SESSION_ID, message: 'request' },
    {
      type: 'tool_call',
      subtype: 'started',
      call_id: callId,
      session_id: SESSION_ID,
      tool_call: { mcpToolCall: { args: descriptor } },
    },
    {
      type: 'tool_call',
      subtype: 'completed',
      call_id: callId,
      session_id: SESSION_ID,
      is_error: false,
      tool_call: { mcpToolCall: { args: descriptor, result: output } },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: SESSION_ID,
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

describe('Cursor Agent CLI activation live adapter', () => {
  it('runs plan, exact-session apply, and evidence through one private capture state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursor activation adapter '));
    const stateDirectory = resolve(root, 'durable-state');
    const guidedConfigPath = resolve(root, 'guided-mcp.json');
    const privateRoot = resolve(root, 'private-root');
    const capturePath = resolve(privateRoot, 'capture.jsonl');
    const settingsPath = resolve(privateRoot, '.cursor', 'cli.json');
    const mcpConfigPath = resolve(privateRoot, '.cursor', 'mcp.json');
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(resolve(privateRoot, '.cursor'), { recursive: true });
    await writeFile(guidedConfigPath, '{}');
    await writeFile(capturePath, '');
    const cleanup = vi.fn(async () => rm(privateRoot, { recursive: true, force: true }));
    const privateState = {
      path: privateRoot,
      workspacePath: privateRoot,
      settingsPath,
      mcpConfigPath,
      capturePath,
      captureCursor: 0,
      environment: {
        PATH: 'safe-path',
        CURSOR_API_KEY: 'ambient-model-key',
        DISCORD_TOKEN: TOKEN,
        HOME: privateRoot,
        USERPROFILE: privateRoot,
      },
      cleanup,
    };
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    const phases = [
      {
        tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
        args: { request: 'build a gaming server' },
        data: plan(),
        phase: 'plan',
      },
      {
        tool: CURSOR_CLI_LIFECYCLE_TOOLS.apply,
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
        tool: CURSOR_CLI_LIFECYCLE_TOOLS.evidence,
        args: { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID },
        data: evidence(),
        phase: 'evidence',
      },
    ];
    let captureOrdinal = 0;
    const invocations = [];
    const adapter = createCursorCliActivationLiveAdapter({
      environment: {
        CURSOR_API_KEY: 'ambient-model-key',
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
      resolveLauncher: async () => ({ command: 'agent', prefix_args: [], kind: 'native' }),
      attestLauncher: async (launcher) => ({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: launcher.kind,
        digest: digest('launcher'),
      }),
      runProcess: vi.fn(async (input) => {
        expect(input.env).toEqual(privateState.environment);
        expect(input.env.CURSOR_API_KEY).toBe('ambient-model-key');
        expect(input.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        invocations.push(input.args);
        if (invocations.length === 1) return hostResult('Cursor Agent CLI 2.4.1\n');
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
        return hostResult(stream(next.tool, next.args, text, privateRoot));
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
        release: '0.26.0',
        hostVersion: '2.4.1',
        target,
        installRoot: root,
        install: { cliDigest: digest('cli'), coreDigest: digest('core') },
        stateDirectory,
        configPath: guidedConfigPath,
        env: { DISCORD_TOKEN: TOKEN },
        binding: target,
        registerSession: () => {},
      });
      expect(session.cursorSessionId).toBe(SESSION_ID);
      await adapter.apply({ session, target, binding: target });
      await adapter.evidence({ session, target, binding: target, apply: session.lastApply });
      expect(invocations).toHaveLength(4);
      expect(invocations[1]).not.toContain('--resume');
      for (const args of invocations.slice(2)) {
        expect(args.slice(-2)).toEqual(['--resume', SESSION_ID]);
        expect(args).toContain('stream-json');
        expect(args).toContain(privateRoot);
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
