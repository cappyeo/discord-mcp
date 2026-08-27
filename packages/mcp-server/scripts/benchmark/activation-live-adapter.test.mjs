import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { createActivationLiveAdapter } from './activation-live-adapter.mjs';
import {
  CLAUDE_CODE_TOOLS,
  classifyClaudeCodeInitial,
  classifyClaudeCodeResume,
  parseClaudeCodeLiveJsonl,
} from './claude-code-live-eval.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = 'token-never-in-argv';
const REQUEST = 'build a gaming server';
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const PLAN_ID = digest('plan');
const BLUEPRINT_ID = digest('blueprint');
const APPROVAL_ID = digest('approval');
const LAUNCHER_DIGEST = digest('launcher');

function claudeStream(tool, input, result) {
  const callId = `${tool}-call`;
  return [
    {
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      claude_code_version: '2.1.228',
    },
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

function apply(status) {
  const bindings = {
    roles: {},
    categories: {},
    channels: {},
    automod_rules: {},
    publications: {},
  };
  return {
    status,
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    progress: {
      completed_total: status === 'partial' ? 1 : 2,
      remaining: status === 'partial' ? 1 : 0,
    },
    evidence: { bindings },
    ...(status === 'partial' ? { error: { retry_after_ms: 0 } } : {}),
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

function normalized(sessionId, tool, qualifiedTool, result) {
  const call = { tool, qualified_tool: qualifiedTool, status: 'completed' };
  Object.defineProperty(call, '__raw', { value: { result }, enumerable: false });
  return {
    session_id: sessionId,
    malformed_json_lines: 0,
    trace: [call],
  };
}

function createAdversarialAdapter({
  responses,
  parseJsonl,
  classifyInitial,
  classifyResume,
  verifyStateDirectoryPath = async (value) => value,
  attestLauncher = async () => ({
    schema_version: 'discord-mcp.host-launcher-identity.v1',
    kind: 'binary',
    digest: LAUNCHER_DIGEST,
  }),
}) {
  const validatePlanResult = vi.fn();
  const validateApplyResult = vi.fn();
  const adapter = createActivationLiveAdapter({
    hostDriver: {
      id: 'claude-code',
      label: 'Claude Code',
      processDidNotCloseCode: 'CLAUDE_CODE_PROCESS_DID_NOT_CLOSE',
      initialTool: 'build_discord_server',
      applyTool: 'guild_blueprint_apply',
      evidenceTool: 'guild_blueprint_evidence',
      initialQualifiedTool: CLAUDE_CODE_TOOLS.initial,
      applyQualifiedTool: CLAUDE_CODE_TOOLS.apply,
      evidenceQualifiedTool: CLAUDE_CODE_TOOLS.evidence,
      sessionField: 'sessionId',
      sessionSchema: 'discord-mcp.claude-code-activation-session.v1',
      initialRequest: REQUEST,
      buildEnvironment: (_environment, { token }) => ({ DISCORD_TOKEN: token }),
      buildArguments: () => [],
      parseJsonl,
      classifyInitial,
      classifyResume,
      contractErrors: () => [],
      preparePrivateState: async () => ({ path: 'C:/private', cleanup: async () => {} }),
      privateEnvironment: (state) => ({ CLAUDE_CONFIG_DIR: state.path }),
      resolveLauncher: async () => ({ command: 'claude', prefix_args: [], kind: 'binary' }),
      runProcess: async () => responses.shift(),
      parseVersion: (stdout) => stdout.trim(),
      sessionId: (value) => value.session_id,
    },
    environment: { DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: 'C:/activation-artifacts' },
    verifyRuntimePackage: async () => ({
      cliPath: 'C:/install/cli.js',
      corePath: 'C:/install/core.js',
    }),
    loadActivityValidator: async () => vi.fn(),
    validatePlanResult,
    validateApplyResult,
    summarizeActivityEvidence: () => ({
      evidence_id: digest('evidence'),
      evidence_body: { schema_version: 'guild_blueprint_activity_evidence.v1' },
    }),
    resolvePublicationTargets: () => [],
    verifyStateDirectoryPath,
    attestLauncher,
  });
  return { adapter, validatePlanResult, validateApplyResult };
}

describe('shared activation live adapter', () => {
  it('drives a Claude host through version, preview, partial apply, complete apply, and evidence', async () => {
    const responses = [
      { stdout: '2.1.228 (Claude Code)', exitCode: 0, signal: null },
      {
        stdout: claudeStream(CLAUDE_CODE_TOOLS.initial, { request: REQUEST }, plan()),
        exitCode: 0,
        signal: null,
      },
      {
        stdout: claudeStream(
          CLAUDE_CODE_TOOLS.apply,
          {
            guild_id: GUILD_ID,
            expected_bot_id: BOT_ID,
            approval_id: APPROVAL_ID,
            plan_ref: PLAN_REF,
            __confirm: true,
          },
          apply('partial'),
        ),
        exitCode: 0,
        signal: null,
      },
      {
        stdout: claudeStream(
          CLAUDE_CODE_TOOLS.apply,
          {
            guild_id: GUILD_ID,
            expected_bot_id: BOT_ID,
            approval_id: APPROVAL_ID,
            plan_ref: PLAN_REF,
            __confirm: true,
          },
          apply('complete'),
        ),
        exitCode: 0,
        signal: null,
      },
      {
        stdout: claudeStream(
          CLAUDE_CODE_TOOLS.evidence,
          { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID },
          evidence(),
        ),
        exitCode: 0,
        signal: null,
      },
    ];
    const runProcess = vi.fn(async () => responses.shift());
    const resolveLauncher = vi.fn(async () => ({
      command: 'C:/host/claude.exe',
      prefix_args: [],
      kind: 'binary',
    }));
    const attestLauncher = vi.fn(async () => ({
      schema_version: 'discord-mcp.host-launcher-identity.v1',
      kind: 'binary',
      digest: LAUNCHER_DIGEST,
    }));
    const privateHome = { path: 'C:/private-claude-state', cleanup: vi.fn(async () => {}) };
    const validator = vi.fn();
    const adapter = createActivationLiveAdapter({
      hostDriver: {
        id: 'claude-code',
        label: 'Claude Code',
        processDidNotCloseCode: 'CLAUDE_CODE_PROCESS_DID_NOT_CLOSE',
        initialTool: 'build_discord_server',
        applyTool: 'guild_blueprint_apply',
        evidenceTool: 'guild_blueprint_evidence',
        initialQualifiedTool: 'mcp__discord-mcp__build_discord_server',
        applyQualifiedTool: 'mcp__discord-mcp__guild_blueprint_apply',
        evidenceQualifiedTool: 'mcp__discord-mcp__guild_blueprint_evidence',
        sessionField: 'sessionId',
        sessionSchema: 'discord-mcp.claude-code-activation-session.v1',
        initialRequest: REQUEST,
        buildEnvironment: (_environment, { token }) => ({ DISCORD_TOKEN: token }),
        buildArguments: ({ phase, resumeMode }) => [phase, resumeMode ?? 'initial'],
        parseJsonl: (stdout, options) => parseClaudeCodeLiveJsonl(stdout, options),
        classifyInitial: classifyClaudeCodeInitial,
        classifyResume: classifyClaudeCodeResume,
        contractErrors: () => [],
        preparePrivateState: async () => privateHome,
        privateEnvironment: (state) => ({ CLAUDE_CONFIG_DIR: state.path }),
        resolveLauncher,
        runProcess,
        parseVersion: (stdout) => stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null,
        sessionId: (value) => value.session_id,
      },
      environment: { DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT: 'C:/activation-artifacts' },
      verifyRuntimePackage: async () => ({
        cliPath: 'C:/install/cli.js',
        corePath: 'C:/install/core.js',
      }),
      loadActivityValidator: async () => validator,
      verifyStateDirectoryPath: async (value) => value,
      validatePlanResult: () => {},
      validateApplyResult: () => {},
      summarizeActivityEvidence: () => ({
        evidence_id: digest('evidence'),
        evidence_body: { schema_version: 'guild_blueprint_activity_evidence.v1' },
      }),
      resolvePublicationTargets: () => [],
      attestLauncher,
    });
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    const binding = { guildId: GUILD_ID, botId: BOT_ID };
    let registered;
    const session = await adapter.launch({
      release: '0.23.0',
      hostVersion: '2.1.228',
      target,
      installRoot: 'C:/install',
      install: { cliDigest: digest('cli'), coreDigest: digest('core') },
      stateDirectory: 'C:/state',
      configPath: 'C:/state/mcp.json',
      env: { DISCORD_TOKEN: TOKEN },
      binding,
      registerSession: (value) => {
        registered = value;
      },
    });
    expect(session).toBe(registered);
    expect(session).toMatchObject({ clientReady: true, firstRequest: true, sessionId: SESSION_ID });
    expect(session.sessionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(session.launcherDigest).toBe(LAUNCHER_DIGEST);
    expect(resolveLauncher).toHaveBeenCalledWith({
      environment: {
        CLAUDE_CONFIG_DIR: 'C:/private-claude-state',
        DISCORD_TOKEN: TOKEN,
      },
      platform: process.platform,
    });

    const applied = await adapter.apply({ session, target, binding });
    expect(applied.status).toBe('complete');
    const verified = await adapter.evidence({ session, target, binding, apply: applied });
    expect(verified).toMatchObject({ status: 'verified', binding });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledTimes(5);
    expect(responses).toHaveLength(0);
    await expect(adapter.closeSession({ session })).resolves.toMatchObject({
      settled: true,
      launcherVerified: true,
    });
    expect(attestLauncher).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the launcher bytes drift before session cleanup', async () => {
    const responses = [
      { stdout: '2.1.228', exitCode: 0, signal: null },
      { stdout: 'initial', exitCode: 0, signal: null },
    ];
    const attestLauncher = vi
      .fn()
      .mockResolvedValueOnce({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: 'binary',
        digest: LAUNCHER_DIGEST,
      })
      .mockResolvedValueOnce({
        schema_version: 'discord-mcp.host-launcher-identity.v1',
        kind: 'binary',
        digest: digest('changed-launcher'),
      });
    const { adapter } = createAdversarialAdapter({
      responses,
      attestLauncher,
      parseJsonl: (stdout) =>
        stdout === 'initial'
          ? normalized(SESSION_ID, 'build_discord_server', CLAUDE_CODE_TOOLS.initial, plan())
          : { malformed_json_lines: 0 },
      classifyInitial: () => 'pass',
      classifyResume: () => 'pass',
    });
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    const session = await adapter.launch({
      release: '0.23.0',
      hostVersion: '2.1.228',
      target,
      installRoot: 'C:/install',
      install: { cliDigest: digest('cli'), coreDigest: digest('core') },
      stateDirectory: 'C:/state',
      configPath: 'C:/state/mcp.json',
      env: { DISCORD_TOKEN: TOKEN },
      binding: target,
      registerSession: () => {},
    });

    await expect(adapter.closeSession({ session })).resolves.toMatchObject({
      settled: false,
      launcherVerified: false,
    });
  });

  it('does not let a dishonest classifier bypass a wrong qualified tool', async () => {
    const responses = [
      { stdout: '2.1.228', exitCode: 0, signal: null },
      { stdout: 'initial', exitCode: 0, signal: null },
    ];
    const { adapter, validatePlanResult } = createAdversarialAdapter({
      responses,
      parseJsonl: (stdout) =>
        stdout === '2.1.228'
          ? { malformed_json_lines: 0 }
          : normalized(
              SESSION_ID,
              'build_discord_server',
              'mcp__evil__build_discord_server',
              plan(),
            ),
      classifyInitial: () => 'pass',
      classifyResume: () => 'pass',
    });
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    await expect(
      adapter.launch({
        release: '0.23.0',
        hostVersion: '2.1.228',
        target,
        installRoot: 'C:/install',
        install: { cliDigest: digest('cli'), coreDigest: digest('core') },
        stateDirectory: 'C:/state',
        configPath: 'C:/state/mcp.json',
        env: { DISCORD_TOKEN: TOKEN },
        binding: target,
        registerSession: () => {},
      }),
    ).rejects.toThrow('exact tool contract');
    expect(validatePlanResult).not.toHaveBeenCalled();
  });

  it('rejects a wrong resume session before apply/evidence validation', async () => {
    const responses = [
      { stdout: '2.1.228', exitCode: 0, signal: null },
      { stdout: 'initial', exitCode: 0, signal: null },
      { stdout: 'apply', exitCode: 0, signal: null },
    ];
    const { adapter, validateApplyResult } = createAdversarialAdapter({
      responses,
      parseJsonl: (stdout) => {
        if (stdout === '2.1.228') return { malformed_json_lines: 0 };
        if (stdout === 'initial')
          return normalized(SESSION_ID, 'build_discord_server', CLAUDE_CODE_TOOLS.initial, plan());
        return normalized(
          '123e4567-e89b-42d3-a456-426614174001',
          'guild_blueprint_apply',
          CLAUDE_CODE_TOOLS.apply,
          apply('complete'),
        );
      },
      classifyInitial: () => 'pass',
      classifyResume: () => 'pass',
    });
    const target = { guildId: GUILD_ID, botId: BOT_ID };
    const session = await adapter.launch({
      release: '0.23.0',
      hostVersion: '2.1.228',
      target,
      installRoot: 'C:/install',
      install: { cliDigest: digest('cli'), coreDigest: digest('core') },
      stateDirectory: 'C:/state',
      configPath: 'C:/state/mcp.json',
      env: { DISCORD_TOKEN: TOKEN },
      binding: target,
      registerSession: () => {},
    });
    await expect(adapter.apply({ session, target, binding: target })).rejects.toThrow(
      'apply session mismatch',
    );
    expect(validateApplyResult).not.toHaveBeenCalled();
  });
});
