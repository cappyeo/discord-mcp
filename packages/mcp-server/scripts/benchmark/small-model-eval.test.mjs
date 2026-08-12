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
} from './small-model-eval.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const TEMPLATE = {
  code: 'GamingTemplate',
  use_url: 'https://discord.new/GamingTemplate',
  verified: true,
  code_match: true,
  permission_handling: 'discarded_and_regenerated',
  evidence_digest: digest('template-evidence'),
  fetched_at: '2026-08-13T00:00:00.000Z',
  source_guild: {
    id: '1533998797863256165',
    snapshot_id: null,
    icon_hash: null,
    preferred_locale: 'en-US',
  },
};
const RAW_TEMPLATE = {
  code: TEMPLATE.code,
  use_url: TEMPLATE.use_url,
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
    target: { guild_id: '1533998797863256165', bot_id: '1533457669384306858' },
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
            target: { guild_id: '1533998797863256165', bot_id: '1533457669384306858' },
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
            target: { guild_id: '1533998797863256165', bot_id: '1533457669384306858' },
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
  });

  it('pins the isolated Codex invocation and enabled MCP tools', () => {
    const args = buildCodexArguments({
      cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
      cwd: 'C:/repo',
      target: { guildId: '1533998797863256165', botId: '1533457669384306858' },
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

  it('writes a fail-closed artifact without spawning Codex when the front door is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-'));
    try {
      const output = join(directory, 'result.json');
      const artifact = await runSmallModelEvaluation({
        output,
        cwd: 'C:/repo',
        trials: 3,
        threshold: 2,
        env: {
          DISCORD_TOKEN: 'x'.repeat(60),
          ALLOWED_GUILDS: '1533998797863256165',
          DISCORD_EXPECTED_BOT_ID: '1533457669384306858',
        },
        run: async () => ({ stdout: `${'a'.repeat(40)}\n` }),
        attest: async () => ({
          cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
          attestation: {
            entrypoint: 'packages/mcp-server/dist/cli.js',
            sha256: digest('cli'),
            source_commit: 'a'.repeat(40),
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
      expect(artifact.trials).toHaveLength(3);
      expect(
        artifact.trials.every((trial) => trial.classification === 'product_front_door_missing'),
      ).toBe(true);
      expect(artifact.aggregate).toMatchObject({
        total: 3,
        passes: 0,
        required_passes: 2,
        meets_threshold: false,
      });
      expect(JSON.parse(await readFile(output, 'utf8')).policy.sha256).toBe(
        digest(SMALL_MODEL_POLICY),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a zero or over-sized pass threshold before any host work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-threshold-'));
    try {
      await expect(
        runSmallModelEvaluation({ output: join(directory, 'zero.json'), trials: 5, threshold: 0 }),
      ).rejects.toThrow('threshold must be between 1 and trials');
      await expect(
        runSmallModelEvaluation({ output: join(directory, 'large.json'), trials: 5, threshold: 6 }),
      ).rejects.toThrow('threshold must be between 1 and trials');
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
        trials: 2,
        threshold: 1,
        env: {
          DISCORD_TOKEN: 'x'.repeat(60),
          ALLOWED_GUILDS: '1533998797863256165',
          DISCORD_EXPECTED_BOT_ID: '1533457669384306858',
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
            entrypoint: 'packages/mcp-server/dist/cli.js',
            sha256: digest('cli'),
            source_commit: 'a'.repeat(40),
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
      ]);
      expect(artifact.aggregate.meets_threshold).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes fail-closed artifacts for synchronous spawn throws and hung timeout kills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-spawn-'));
    const common = {
      cwd: 'C:/repo',
      trials: 1,
      threshold: 1,
      env: {
        DISCORD_TOKEN: 'x'.repeat(60),
        ALLOWED_GUILDS: '1533998797863256165',
        DISCORD_EXPECTED_BOT_ID: '1533457669384306858',
      },
      platform: 'linux',
      run: async (_command, args) => ({
        stdout: args?.[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : 'codex 1.0.0\n',
      }),
      attest: async () => ({
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        attestation: {
          entrypoint: 'packages/mcp-server/dist/cli.js',
          sha256: digest('cli'),
          source_commit: 'a'.repeat(40),
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
      expect(
        JSON.parse(await readFile(join(directory, 'spawn-error.json'))).aggregate,
      ).toMatchObject({
        passes: 0,
        meets_threshold: false,
      });

      const timeoutChild = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        return child;
      };
      const timeoutArtifact = await runSmallModelEvaluation({
        ...common,
        output: join(directory, 'timeout.json'),
        timeoutMs: 1,
        spawn: timeoutChild,
      });
      expect(timeoutArtifact.trials[0]?.classification).toBe('host_invalid');
      expect(timeoutArtifact.trials[0]?.trace).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
