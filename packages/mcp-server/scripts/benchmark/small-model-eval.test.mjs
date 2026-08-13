import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asksServerTypeClarification,
  buildCodexArguments,
  buildCodexEnvironment,
  classifySmallModelTrial,
  ENABLED_TOOLS,
  parseCodexJsonl,
  parseCodexTrialOutput,
  resolveCodexLauncher,
  runSmallModelEvaluation,
  SMALL_MODEL,
  SMALL_MODEL_POLICY,
  SMALL_MODEL_POLICY_VERSION,
  SMALL_MODEL_REQUEST,
  terminateCodexProcessTree,
} from './small-model-eval.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const BUILD_ATTESTATION = {
  entrypoint: 'packages/mcp-server/dist/cli.js',
  sha256: digest('cli'),
  source_commit: 'a'.repeat(40),
  core_entrypoint: 'packages/mcp-core/dist/index.js',
  core_sha256: digest('core'),
  core_source_commit: 'a'.repeat(40),
  files: [{ path: 'packages/mcp-server/dist/cli.js', sha256: digest('cli') }],
  core_files: [{ path: 'packages/mcp-core/dist/index.js', sha256: digest('core') }],
};

const TEMPLATE = {
  code: 'GamingTemplate',
  use_url: 'https://discord.new/GamingTemplate',
  verified: true,
  code_match: true,
  permission_handling: 'discarded_and_regenerated',
  contributes: ['gaming'],
  structural_contributions: ['categories', 'text_channels', 'custom_roles'],
  evidence_digest: digest('template-evidence'),
  fetched_at: '2026-08-13T00:00:00.000Z',
  source_guild: {
    id: '1537363439452823645',
    snapshot_id: null,
    icon_hash: null,
    preferred_locale: 'en-US',
  },
};
const RAW_TEMPLATE = {
  code: TEMPLATE.code,
  use_url: TEMPLATE.use_url,
  contributes: TEMPLATE.contributes,
  structural_contributions: TEMPLATE.structural_contributions,
  quality: {
    verified: true,
    code_match: true,
    permission_handling: 'discarded_and_regenerated',
  },
  provenance: {
    evidence_digest: TEMPLATE.evidence_digest,
    fetched_at: TEMPLATE.fetched_at,
    source_guild: TEMPLATE.source_guild,
  },
};

function planSummary() {
  return {
    status: 'ready',
    target: { guild_id: '1537363439452823645', bot_id: '1533719084636700773' },
    counts: {
      roles: 9,
      categories: 5,
      channels: 18,
      onboarding_prompts: 2,
      automod_rules: 3,
      publications: 3,
      operations: 42,
    },
    safety: {
      source_permissions_discarded: true,
      source_overwrites_discarded: true,
      severe_generated_role_permissions: 0,
      dangling_symbolic_references: 0,
      onboarding_requirements_met: true,
      components_v2_pre_resolution_valid: true,
      blueprint_validation: 'passed',
      target_readback: 'passed',
    },
    template_evidence: {
      catalog_version: 'catalog-v1',
      permission_policy: 'discard_source_and_regenerate',
      primary: TEMPLATE,
      inspirations: [],
    },
  };
}

function liveResult() {
  const summary = planSummary();
  return {
    status: summary.status,
    target: summary.target,
    blueprint: {
      roles: Array.from({ length: summary.counts.roles }, () => ({})),
      categories: Array.from({ length: summary.counts.categories }, () => ({})),
      channels: Array.from({ length: summary.counts.channels }, () => ({})),
      onboarding: {
        prompts: Array.from({ length: summary.counts.onboarding_prompts }, () => ({})),
      },
      automod: { rules: Array.from({ length: summary.counts.automod_rules }, () => ({})) },
      components_v2: {
        publications: Array.from({ length: summary.counts.publications }, () => ({})),
      },
      safety: summary.safety,
    },
    verification: {
      blueprint_validation: 'passed',
      target_readback: 'passed',
    },
    source: {
      catalog_version: 'catalog-v1',
      permission_policy: 'discard_source_and_regenerate',
      primary: RAW_TEMPLATE,
      inspirations: [],
    },
    summary: { total_operations: summary.counts.operations },
  };
}

function directOutput() {
  return [
    JSON.stringify({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        tool: 'build_discord_server',
        arguments: { request: SMALL_MODEL_REQUEST },
        result: {
          structured_content: {
            status: 'ready',
            target: { guild_id: '1537363439452823645', bot_id: '1533719084636700773' },
            ...liveResult(),
          },
        },
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        tool: 'build_discord_server',
        arguments: { request: SMALL_MODEL_REQUEST },
        result: {
          structured_content: {
            status: 'ready',
            target: { guild_id: '1537363439452823645', bot_id: '1533719084636700773' },
            ...liveResult(),
          },
        },
      },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 4 } }),
  ].join('\n');
}

describe('small-model evaluation contract', () => {
  it('keeps the exact North Star request and a generic reusable policy', () => {
    expect(SMALL_MODEL).toBe('gpt-5.6-luna');
    expect(SMALL_MODEL_REQUEST).toBe('Dựng cho tôi một server gaming chuyên nghiệp.');
    expect(SMALL_MODEL_POLICY_VERSION).toBe('discord-mcp.small-model-policy.v1');
    expect(SMALL_MODEL_POLICY).toContain('Discord workspace');
    expect(SMALL_MODEL_POLICY).toContain('VPS');
    expect(SMALL_MODEL_POLICY).toContain('Never repeat an identical tool call');
    expect(SMALL_MODEL_POLICY).not.toContain('build_discord_server');
    expect(digest(SMALL_MODEL_POLICY)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('parses direct MCP calls without retaining result or transcript content', () => {
    const parsed = parseCodexJsonl(directOutput());
    expect(parsed.trace).toEqual([
      {
        tool: 'build_discord_server',
        argument_keys: ['request'],
        request_digest: digest(SMALL_MODEL_REQUEST),
        status: 'completed',
        result_summary: expect.objectContaining({ status: 'ready' }),
      },
    ]);
    expect(parsed.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
    expect(JSON.stringify(parsed)).not.toContain('structured_content');
    expect(JSON.stringify(parsed)).not.toContain('plan_token');
    expect(JSON.stringify(parsed)).not.toContain('call-1');
  });

  it('fails closed when a call_id completion diverges from its start contract', () => {
    const start = {
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        tool: 'build_discord_server',
        arguments: { request: SMALL_MODEL_REQUEST },
      },
    };
    const completion = {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        tool: 'guild_blueprint_apply',
        arguments: { request: 'different request', extra: true },
      },
    };
    const parsed = parseCodexJsonl(`${JSON.stringify(start)}\n${JSON.stringify(completion)}`);
    expect(parsed.contract_errors).toContain('call_id_contract_mismatch');
    expect(classifySmallModelTrial({ trace: parsed.trace })).toBe('tool_contract_failure');
  });

  it('rejects each individual call_id completion divergence', () => {
    const fields = [
      ['tool', 'guild_blueprint_apply'],
      ['arguments', { request: SMALL_MODEL_REQUEST, extra: true }],
      ['arguments', { request: 'a different request' }],
      [
        'arguments',
        {
          args: { request: SMALL_MODEL_REQUEST, tool: 'guild_blueprint_apply' },
          tool: 'mcp_tools_read',
        },
      ],
    ];
    for (const [field, value] of fields) {
      const start = {
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'call-1',
          tool: 'build_discord_server',
          arguments: { request: SMALL_MODEL_REQUEST },
        },
      };
      const item = {
        type: 'mcp_tool_call',
        id: 'call-1',
        tool: 'build_discord_server',
        arguments: { request: SMALL_MODEL_REQUEST },
      };
      item[field] = value;
      const parsed = parseCodexJsonl(
        `${JSON.stringify(start)}\n${JSON.stringify({ type: 'item.completed', item })}`,
      );
      expect(parsed.contract_errors.length).toBeGreaterThan(0);
    }
  });

  it('accepts exactly one completed direct architecture call', () => {
    const parsed = parseCodexJsonl(directOutput());
    expect(classifySmallModelTrial({ trace: parsed.trace, clarificationDetected: false })).toBe(
      'pass',
    );
  });

  it('accepts only the carefully validated search-to-read fallback', () => {
    const trace = [
      {
        tool: 'mcp_tools_search',
        argument_keys: ['limit', 'query'],
        request_digest: digest(SMALL_MODEL_REQUEST),
        status: 'completed',
      },
      {
        tool: 'mcp_tools_read',
        argument_keys: ['args', 'tool'],
        nested_argument_keys: ['request'],
        request_digest: digest(SMALL_MODEL_REQUEST),
        target_tool: 'build_discord_server',
        status: 'completed',
        result_summary: planSummary(),
      },
    ];
    expect(classifySmallModelTrial({ trace })).toBe('pass');
  });

  it('fails closed for no call, unsafe calls, duplicate calls, and clarification', () => {
    expect(classifySmallModelTrial({ trace: [], frontDoorAvailable: false })).toBe(
      'product_front_door_missing',
    );
    expect(classifySmallModelTrial({ trace: [] })).toBe('model_no_tool_call');
    const complete = parseCodexJsonl(directOutput()).trace;
    expect(classifySmallModelTrial({ trace: complete, truncated: true })).toBe('host_invalid');
    expect(classifySmallModelTrial({ trace: [], signal: 'SIGTERM' })).toBe('host_invalid');
    expect(
      classifySmallModelTrial({
        trace: [
          {
            tool: 'guild_blueprint_apply',
            argument_keys: [],
            request_digest: null,
            status: 'completed',
          },
        ],
      }),
    ).toBe('unsafe_tool_call');
    const parsed = parseCodexJsonl(directOutput());
    expect(classifySmallModelTrial({ trace: [...parsed.trace, ...parsed.trace] })).toBe(
      'tool_contract_failure',
    );
    expect(classifySmallModelTrial({ trace: parsed.trace, clarificationDetected: true })).toBe(
      'planner_failure',
    );
    expect(asksServerTypeClarification('Bạn muốn dựng loại nào?')).toBe(true);
    expect(
      parseCodexJsonl(
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: 'Which kind of server do you mean?' }],
          },
        }),
      ).clarification_detected,
    ).toBe(true);
    expect(asksServerTypeClarification('I will prepare the Discord guild blueprint.')).toBe(false);
    const overflow = parseCodexTrialOutput(`${'{}\n'.repeat(100_001)}`);
    expect(overflow.parse_failed).toBe(true);
    expect(classifySmallModelTrial({ trace: [], truncated: true })).toBe('host_invalid');
  });

  it('rejects invalid template portfolios and inconsistent status/operation evidence', () => {
    const parsed = parseCodexJsonl(directOutput());
    const trace = parsed.trace;
    const invalid = structuredClone(trace);
    invalid[0].result_summary.template_evidence.inspirations = [
      invalid[0].result_summary.template_evidence.primary,
      invalid[0].result_summary.template_evidence.primary,
      invalid[0].result_summary.template_evidence.primary,
      invalid[0].result_summary.template_evidence.primary,
    ];
    expect(classifySmallModelTrial({ trace: invalid })).toBe('tool_contract_failure');
    const readyWithoutOps = structuredClone(trace);
    readyWithoutOps[0].result_summary.counts.operations = 0;
    expect(classifySmallModelTrial({ trace: readyWithoutOps })).toBe('tool_contract_failure');
    const invalidCapability = structuredClone(trace);
    invalidCapability[0].result_summary.template_evidence.primary.contributes = ['untrusted'];
    expect(classifySmallModelTrial({ trace: invalidCapability })).toBe('tool_contract_failure');
    const decorative = structuredClone(trace);
    decorative[0].result_summary.template_evidence.inspirations = [
      {
        ...decorative[0].result_summary.template_evidence.primary,
        code: 'decorative-inspiration',
        use_url: 'https://discord.new/decorative-inspiration',
        contributes: [],
        structural_contributions: [],
      },
    ];
    expect(classifySmallModelTrial({ trace: decorative })).toBe('tool_contract_failure');
    const noopPrimary = structuredClone(trace);
    noopPrimary[0].result_summary.template_evidence.primary.contributes = [];
    noopPrimary[0].result_summary.template_evidence.primary.structural_contributions = [];
    expect(classifySmallModelTrial({ trace: noopPrimary })).toBe('tool_contract_failure');
    const missingPrimaryContribution = structuredClone(trace);
    delete missingPrimaryContribution[0].result_summary.template_evidence.primary.contributes;
    delete missingPrimaryContribution[0].result_summary.template_evidence.primary
      .structural_contributions;
    expect(classifySmallModelTrial({ trace: missingPrimaryContribution })).toBe(
      'tool_contract_failure',
    );
  });

  it('pins the isolated Codex invocation and enabled MCP tools', () => {
    const args = buildCodexArguments({
      cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
      cwd: 'C:/repo',
      target: { guildId: '1537363439452823645', botId: '1533719084636700773' },
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--json',
      ]),
    );
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.6-luna');
    expect(args.join('\n')).toContain('model_reasoning_effort="low"');
    expect(args.join('\n')).toContain('MCP_DRY_RUN="true"');
    expect(args.join('\n')).toContain('MCP_WRITE_MODE="preview"');
    expect(args.join('\n')).toContain(JSON.stringify([...ENABLED_TOOLS]));
    expect(args.at(-1)).toBe(SMALL_MODEL_REQUEST);
    expect(args.join('\n')).toContain(
      `developer_instructions=${JSON.stringify(SMALL_MODEL_POLICY)}`,
    );
  });

  it('uses a minimal Codex environment and a Windows-safe launcher', async () => {
    const env = buildCodexEnvironment(
      {
        PATH: 'safe-path',
        CODEX_HOME: 'C:/codex',
        OPENAI_API_KEY: 'openai-key',
        DISCORD_TOKEN: 'old-token',
        SECRET_TOKEN: 'must-not-forward',
        AWS_SECRET_ACCESS_KEY: 'must-not-forward',
      },
      { token: 'x'.repeat(60) },
    );
    expect(env).toEqual({
      PATH: 'safe-path',
      CODEX_HOME: 'C:/codex',
      OPENAI_API_KEY: 'openai-key',
      DISCORD_TOKEN: 'x'.repeat(60),
    });
    const calls = [];
    await expect(
      resolveCodexLauncher({
        platform: 'win32',
        run: async (command, args) => {
          calls.push([command, args]);
          return { stdout: 'C:\\Program Files\\Codex\\codex.exe\r\n' };
        },
      }),
    ).resolves.toEqual({
      command: 'C:\\Program Files\\Codex\\codex.exe',
      prefix_args: [],
      kind: 'binary',
    });
    expect(calls[0]).toEqual(['where.exe', ['codex.exe']]);
  });

  it('terminates the complete Codex process tree on Windows and POSIX', async () => {
    const windowsCommands = [];
    const windowsChild = { pid: 12345, kill: () => false };
    await expect(
      terminateCodexProcessTree({
        child: windowsChild,
        platform: 'win32',
        run: async (command, args, options) => windowsCommands.push({ command, args, options }),
      }),
    ).resolves.toBe(true);
    await terminateCodexProcessTree({
      child: windowsChild,
      platform: 'win32',
      force: true,
      run: async (command, args, options) => windowsCommands.push({ command, args, options }),
    });
    expect(windowsCommands.map(({ args }) => args)).toEqual([
      ['/PID', '12345', '/T'],
      ['/PID', '12345', '/T', '/F'],
    ]);

    const posixSignals = [];
    const posixChild = { pid: 54321, kill: () => false };
    await terminateCodexProcessTree({
      child: posixChild,
      platform: 'linux',
      kill: (pid, signal) => posixSignals.push([pid, signal]),
    });
    await terminateCodexProcessTree({
      child: posixChild,
      platform: 'linux',
      force: true,
      kill: (pid, signal) => posixSignals.push([pid, signal]),
    });
    expect(posixSignals).toEqual([
      [-54321, 'SIGTERM'],
      [-54321, 'SIGKILL'],
    ]);
  });

  it('writes a fail-closed artifact without spawning Codex when the front door is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-'));
    try {
      const output = join(directory, 'result.json');
      const artifact = await runSmallModelEvaluation({
        output,
        cwd: 'C:/repo',
        trials: 5,
        threshold: 4,
        env: {
          DISCORD_TOKEN: 'x'.repeat(60),
          ALLOWED_GUILDS: '1537363439452823645',
          DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
        },
        run: async () => ({ stdout: `${'a'.repeat(40)}\n` }),
        attest: async () => ({
          cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
          attestation: {
            ...BUILD_ATTESTATION,
          },
        }),
        openSession: async () => ({
          toolNames: ['mcp_tools_read'],
          instructions: 'No architecture front door',
          close: async () => {},
        }),
        spawn: () => {
          throw new Error('Codex must not spawn');
        },
      });
      expect(artifact.trials).toHaveLength(5);
      expect(
        artifact.trials.every((trial) => trial.classification === 'product_front_door_missing'),
      ).toBe(true);
      expect(artifact.aggregate).toMatchObject({
        total: 5,
        passes: 0,
        required_passes: 4,
        meets_threshold: false,
      });
      expect(JSON.parse(await readFile(output, 'utf8')).policy.sha256).toBe(
        digest(SMALL_MODEL_POLICY),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects any downgrade of the fixed five-trial, four-pass gate before host work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-threshold-'));
    try {
      await expect(
        runSmallModelEvaluation({ output: join(directory, 'short.json'), trials: 1, threshold: 1 }),
      ).rejects.toThrow('requires exactly 5 trials');
      await expect(
        runSmallModelEvaluation({ output: join(directory, 'weak.json'), trials: 5, threshold: 1 }),
      ).rejects.toThrow('requires exactly 4 passes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a valid-looking target outside the controlled guild and bot pool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-target-'));
    let hostCalls = 0;
    try {
      await expect(
        runSmallModelEvaluation({
          output: join(directory, 'outside.json'),
          env: {
            DISCORD_TOKEN: 'x'.repeat(60),
            ALLOWED_GUILDS: '1533478783867420712',
            DISCORD_DEFAULT_GUILD_ID: '1533478783867420712',
            DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
          },
          run: async () => {
            hostCalls += 1;
            return { stdout: `${'a'.repeat(40)}\n` };
          },
        }),
      ).rejects.toThrow(/outside the controlled guild\/bot scope/);
      expect(hostCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records host_invalid trials when Codex resolution fails after product preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-host-'));
    try {
      let runCalls = 0;
      const runOptions = [];
      const artifact = await runSmallModelEvaluation({
        output: join(directory, 'host.json'),
        cwd: 'C:/repo',
        trials: 5,
        threshold: 4,
        env: {
          DISCORD_TOKEN: 'x'.repeat(60),
          ALLOWED_GUILDS: '1537363439452823645',
          DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
        },
        run: async (_command, _args, options) => {
          runCalls += 1;
          runOptions.push(options);
          if (runCalls === 1) return { stdout: `${'a'.repeat(40)}\n` };
          throw new Error('Codex unavailable');
        },
        attest: async () => ({
          cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
          attestation: {
            ...BUILD_ATTESTATION,
          },
        }),
        openSession: async () => ({
          toolNames: [...ENABLED_TOOLS],
          instructions: 'build_discord_server',
          close: async () => {},
        }),
        spawn: () => {
          throw new Error('Codex must not spawn after resolution failure');
        },
      });
      expect(artifact.host.codex).toBe('unavailable');
      expect(runOptions[1]?.timeout).toBe(15_000);
      expect(artifact.trials.map((trial) => trial.classification)).toEqual([
        'host_invalid',
        'host_invalid',
        'host_invalid',
        'host_invalid',
        'host_invalid',
      ]);
      expect(artifact.aggregate.meets_threshold).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cleans up the private runtime when build attestation validation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-cleanup-'));
    let cleanupCalls = 0;
    let sessionCalls = 0;
    try {
      await expect(
        runSmallModelEvaluation({
          output: join(directory, 'invalid-attestation.json'),
          cwd: 'C:/repo',
          env: {
            DISCORD_TOKEN: 'x'.repeat(60),
            ALLOWED_GUILDS: '1537363439452823645',
            DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
          },
          run: async () => ({ stdout: `${'a'.repeat(40)}\n` }),
          attest: async () => ({
            cliPath: 'C:/repo/private/cli.js',
            attestation: { entrypoint: 'invalid' },
            cleanup: async () => {
              cleanupCalls += 1;
            },
          }),
          openSession: async () => {
            sessionCalls += 1;
            throw new Error('session must not open');
          },
        }),
      ).rejects.toThrow(/attestation is invalid/);
      expect(cleanupCalls).toBe(1);
      expect(sessionCalls).toBe(0);

      let closeFailureCleanupCalls = 0;
      await expect(
        runSmallModelEvaluation({
          output: join(directory, 'close-failure.json'),
          cwd: 'C:/repo',
          env: {
            DISCORD_TOKEN: 'x'.repeat(60),
            ALLOWED_GUILDS: '1537363439452823645',
            DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
          },
          run: async () => ({ stdout: `${'a'.repeat(40)}\n` }),
          attest: async () => ({
            cliPath: 'C:/repo/private/cli.js',
            attestation: { ...BUILD_ATTESTATION },
            cleanup: async () => {
              closeFailureCleanupCalls += 1;
            },
          }),
          openSession: async () => ({
            toolNames: [],
            instructions: '',
            close: async () => {
              throw new Error('preflight close failed');
            },
          }),
        }),
      ).rejects.toThrow('preflight close failed');
      expect(closeFailureCleanupCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes fail-closed artifacts for synchronous spawn throws and hung timeout kills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-spawn-'));
    const common = {
      cwd: 'C:/repo',
      trials: 5,
      threshold: 4,
      env: {
        DISCORD_TOKEN: 'x'.repeat(60),
        ALLOWED_GUILDS: '1537363439452823645',
        DISCORD_EXPECTED_BOT_ID: '1533719084636700773',
      },
      platform: 'linux',
      run: async (_command, args) => ({
        stdout: args?.[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : 'codex 1.0.0\n',
      }),
      attest: async () => ({
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        attestation: {
          ...BUILD_ATTESTATION,
        },
      }),
      openSession: async () => ({
        toolNames: [...ENABLED_TOOLS],
        instructions: 'build_discord_server',
        close: async () => {},
      }),
    };
    try {
      const spawnErrorArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'spawn-error.json'),
        spawn: () => {
          throw new Error('spawn denied');
        },
      });
      expect(spawnErrorArtifact.trials[0]?.classification).toBe('host_invalid');
      expect(spawnErrorArtifact.trials[0]?.contract_errors).toEqual(['host_spawn_error']);
      expect(
        JSON.parse(await readFile(join(directory, 'spawn-error.json'))).aggregate,
      ).toMatchObject({
        passes: 0,
        meets_threshold: false,
      });

      const timeoutSignals = [];
      const timeoutSpawnOptions = [];
      const timeoutChild = (_command, _args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        timeoutSpawnOptions.push(options);
        child.kill = (signal) => {
          timeoutSignals.push(signal);
          queueMicrotask(() => child.emit('close', null, signal));
          return true;
        };
        return child;
      };
      const timeoutArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'timeout.json'),
        timeoutMs: 1,
        terminationGraceMs: 50,
        spawn: timeoutChild,
      });
      expect(timeoutArtifact.trials[0]?.classification).toBe('host_invalid');
      expect(timeoutArtifact.trials[0]?.trace).toEqual([]);
      expect(timeoutArtifact.trials[0]?.contract_errors).toEqual(['host_timeout', 'host_signal']);
      expect(timeoutSignals).toEqual(['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGTERM']);
      expect(timeoutSpawnOptions).toHaveLength(5);
      expect(timeoutSpawnOptions.every((options) => options.detached === true)).toBe(true);

      const nonzeroExitChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 17, null));
        return child;
      };
      const nonzeroExitArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'nonzero-exit.json'),
        spawn: nonzeroExitChild,
      });
      expect(nonzeroExitArtifact.trials[0]?.classification).toBe('host_invalid');
      expect(nonzeroExitArtifact.trials[0]?.contract_errors).toEqual(['host_nonzero_exit']);

      const truncatedChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1, 'x'));
          child.emit('close', 0, null);
        });
        return child;
      };
      const truncatedArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'stdout-truncated.json'),
        spawn: truncatedChild,
      });
      expect(truncatedArtifact.trials[0]?.classification).toBe('host_invalid');
      expect(truncatedArtifact.trials[0]?.contract_errors).toEqual(['host_stdout_truncated']);

      const passingChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', directOutput());
          child.emit('close', 0, null);
        });
        return child;
      };
      const passingArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'passing.json'),
        spawn: passingChild,
      });
      expect(passingArtifact.trials.every((trial) => trial.classification === 'pass')).toBe(true);
      expect(passingArtifact.trials.every((trial) => trial.contract_errors.length === 0)).toBe(
        true,
      );

      let stuckSpawnCount = 0;
      const stuckSignals = [];
      const stuckArtifactPromise = runSmallModelEvaluation({
        ...common,
        output: join(directory, 'stuck.json'),
        timeoutMs: 1,
        terminationGraceMs: 1,
        spawn: () => {
          stuckSpawnCount += 1;
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = (signal) => {
            stuckSignals.push(signal);
            return true;
          };
          return child;
        },
      });
      await expect(stuckArtifactPromise).rejects.toThrow(/process tree did not close/);
      expect(stuckSpawnCount).toBe(1);
      expect(stuckSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
