import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  buildSmallModelLiveArguments,
  classifySmallModelLiveInitial,
  classifySmallModelLiveResume,
  parseSmallModelLiveJsonl,
  runSmallModelLiveEvaluation,
} from './small-model-live-eval.mjs';

const THREAD_ID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_V7_THREAD_ID = '019fc1fa-f933-79a0-b255-4e868edf0c71';
const GUILD_ID = '1537363439452823645';
const BOT_ID = '1533719084636700773';
const REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';
const TOKEN = 'x'.repeat(60);
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function line(value) {
  return JSON.stringify(value);
}

function threadStarted(id = THREAD_ID) {
  return { type: 'thread.started', thread_id: id };
}

function initialOutput({ id = THREAD_ID, result = {} } = {}) {
  return [
    threadStarted(id),
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'build-call',
        name: 'build_discord_server',
        arguments: { request: REQUEST },
        result: {
          structured_content: {
            status: 'ready',
            target: { guild_id: GUILD_ID, bot_id: BOT_ID },
            summary: { total_operations: 3 },
            plan_id: digest('plan'),
            blueprint_id: digest('blueprint'),
            approval_id: digest('approval'),
            plan_token: 'opaque-plan-token-must-not-leak',
            ...result,
          },
        },
      },
    },
  ]
    .map(line)
    .join('\n');
}

function applyOutput({ id = THREAD_ID, status = 'complete' } = {}) {
  return [
    threadStarted(id),
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'apply-call',
        name: 'guild_blueprint_apply',
        arguments: {
          guild_id: GUILD_ID,
          expected_bot_id: BOT_ID,
          plan_token: 'opaque-plan-token-must-not-leak',
          approval_id: digest('approval'),
          operation_budget: 25,
          __confirm: true,
        },
        result: {
          structured_content: {
            status,
            target: { guild_id: GUILD_ID, bot_id: BOT_ID },
            plan_id: digest('plan'),
            blueprint_id: digest('blueprint'),
            progress: { completed_total: 3, remaining: 0 },
            next_action: 'evidence',
          },
        },
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'evidence-call',
        name: 'guild_blueprint_evidence',
        arguments: {
          guild_id: GUILD_ID,
          expected_bot_id: BOT_ID,
          plan_id: digest('plan'),
        },
        result: {
          structured_content: {
            status: 'verified',
            target: { guild_id: GUILD_ID, bot_id: BOT_ID },
            plan_id: digest('plan'),
            blueprint_id: digest('blueprint'),
            evidence_id: digest('evidence'),
            verification: {
              identity_verified: true,
              guild_verified: true,
              readback: 'match',
              remaining_operations: [],
              blockers: [],
            },
          },
        },
      },
    },
  ]
    .map(line)
    .join('\n');
}

function partialApplyOutput({ id = THREAD_ID } = {}) {
  return (
    line(threadStarted(id)) +
    '\n' +
    line({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'partial-apply-call',
        name: 'guild_blueprint_apply',
        arguments: {
          guild_id: GUILD_ID,
          expected_bot_id: BOT_ID,
          plan_token: 'opaque-plan-token-must-not-leak',
          approval_id: digest('approval'),
          operation_budget: 25,
          __confirm: true,
        },
        result: {
          structured_content: {
            status: 'partial',
            target: { guild_id: GUILD_ID, bot_id: BOT_ID },
            plan_id: digest('plan'),
            blueprint_id: digest('blueprint'),
            progress: { completed_total: 1, remaining: 2 },
            error: { code: 'BUSY', retry_after_ms: 37 },
            next_action: 'resume',
          },
        },
      },
    })
  );
}

describe('small-model live evaluation contract', () => {
  it('extracts only the exact thread.started UUID and sanitizes tool results', () => {
    const parsed = parseSmallModelLiveJsonl(
      initialOutput({
        result: { plan_token: 'secret-plan-token', approval_id: digest('approval') },
      }),
    );
    expect(parsed.thread_id).toBe(THREAD_ID);
    expect(parsed.thread_ids).toEqual([THREAD_ID]);
    expect(parsed.trace).toEqual([
      expect.objectContaining({
        tool: 'build_discord_server',
        argument_keys: ['request'],
        request_digest: digest(REQUEST),
        status: 'completed',
      }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain('plan_token');
    expect(JSON.stringify(parsed)).not.toContain('opaque-plan-token');
    expect(parsed.trace[0].result_summary.plan_digest).toBe(digest('secret-plan-token'));
    expect(parsed.trace[0]).not.toHaveProperty('__raw');
  });

  it('accepts the UUIDv7 thread identifiers emitted by current Codex sessions', () => {
    const parsed = parseSmallModelLiveJsonl(initialOutput({ id: UUID_V7_THREAD_ID }));
    expect(parsed.thread_id).toBe(UUID_V7_THREAD_ID);
    expect(parsed.contract_errors).toEqual([]);
  });

  it('fails closed when thread.started carries a non-UUID identifier', () => {
    const parsed = parseSmallModelLiveJsonl(initialOutput({ id: 'not-a-uuid' }));
    expect(parsed.contract_errors).toContain('thread_id_invalid');
    expect(
      classifySmallModelLiveInitial({
        parsed,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        request: REQUEST,
      }),
    ).toBe('initial_contract_failure');
  });

  it('fails closed on a tool call that never receives a completion event', () => {
    const parsed = parseSmallModelLiveJsonl(
      [
        threadStarted(),
        {
          type: 'item.started',
          item: {
            type: 'mcp_tool_call',
            id: 'unfinished-call',
            name: 'build_discord_server',
            arguments: { request: REQUEST },
          },
        },
      ]
        .map(line)
        .join('\n'),
    );
    expect(parsed.contract_errors).toContain('tool_call_incomplete');
    expect(
      classifySmallModelLiveInitial({
        parsed,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        request: REQUEST,
      }),
    ).toBe('initial_contract_failure');
  });

  it('requires exactly one initial build call', () => {
    const parsed = parseSmallModelLiveJsonl(initialOutput());
    expect(
      classifySmallModelLiveInitial({
        parsed,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        request: REQUEST,
      }),
    ).toBe('pass');

    const unsafe = parseSmallModelLiveJsonl(`${initialOutput()}\n${applyOutput()}`);
    expect(
      classifySmallModelLiveInitial({
        parsed: unsafe,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        request: REQUEST,
      }),
    ).toBe('initial_contract_failure');
  });

  it('requires apply confirmation fields and verified evidence on resume', () => {
    const parsed = parseSmallModelLiveJsonl(applyOutput());
    expect(
      classifySmallModelLiveResume({
        parsed,
        sessionId: THREAD_ID,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        binding: {
          plan_id: digest('plan'),
          blueprint_id: digest('blueprint'),
          approval_id: digest('approval'),
          plan_digest: digest('opaque-plan-token-must-not-leak'),
        },
      }),
    ).toBe('pass');
    expect(parsed.trace[0].argument_keys).toContain('plan_token');
    expect(parsed.trace[0].confirmed).toBe(true);
    expect(parsed.trace[0].result_summary).not.toHaveProperty('plan_token');

    const wrongSession = parseSmallModelLiveJsonl(
      applyOutput({ id: '123e4567-e89b-42d3-a456-426614174001' }),
    );
    expect(
      classifySmallModelLiveResume({
        parsed: wrongSession,
        sessionId: THREAD_ID,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        binding: {
          plan_id: digest('plan'),
          blueprint_id: digest('blueprint'),
          approval_id: digest('approval'),
          plan_digest: digest('opaque-plan-token-must-not-leak'),
        },
      }),
    ).toBe('session_mismatch');
  });

  it('builds separate initial and exact-id resume commands with live MCP gating', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-live-args-'));
    try {
      const initial = buildSmallModelLiveArguments({
        phase: 'initial',
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        cwd: 'C:/repo',
        stateDirectory: directory,
        target: { guildId: GUILD_ID, botId: BOT_ID },
      });
      const resume = buildSmallModelLiveArguments({
        phase: 'resume',
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        cwd: 'C:/repo',
        stateDirectory: directory,
        target: { guildId: GUILD_ID, botId: BOT_ID },
        sessionId: THREAD_ID,
      });
      expect(initial).not.toContain('--ephemeral');
      expect(initial).not.toContain('--last');
      expect(initial.at(-1)).toBe(REQUEST);
      expect(resume).toContain('resume');
      expect(resume).toContain(THREAD_ID);
      expect(resume).not.toContain('--last');
      expect(resume).not.toContain('--sandbox');
      expect(resume).not.toContain('--cd');
      expect(initial).toContain('--sandbox');
      expect(initial).toContain('--cd');
      expect(initial.join('\n')).toContain('MCP_DRY_RUN="false"');
      expect(initial.join('\n')).toContain('MCP_WRITE_MODE="allow"');
      expect(initial.join('\n')).toContain('MCP_TOOL_SURFACE="progressive"');
      expect(resume.join('\n')).toContain('MCP_TOOL_SURFACE="full"');
      expect(initial.join('\n')).toContain(directory.replaceAll('\\', '\\\\'));
      expect(initial.join('\n')).toContain('["build_discord_server"]');
      expect(initial.join('\n')).toContain('calling build_discord_server exactly once');
      expect(initial.join('\n')).toContain('Stop after the preview');
      expect(resume.join('\n')).toContain('["guild_blueprint_apply","guild_blueprint_evidence"]');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects targets outside the controlled guild and bot pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-live-controlled-'));
    try {
      expect(() =>
        buildSmallModelLiveArguments({
          phase: 'initial',
          cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
          cwd: 'C:/repo',
          stateDirectory: directory,
          target: { guildId: '1537332825978568745', botId: BOT_ID },
        }),
      ).toThrow('controlled guild and bot');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs initial, waits for external approval, then resumes the same session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-live-run-'));
    const calls = [];
    const approvals = [];
    const validated = [];
    let cleanupCalls = 0;
    try {
      const result = await runSmallModelLiveEvaluation({
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        cwd: 'C:/repo',
        stateDirectory: directory,
        target: { guildId: GUILD_ID, botId: BOT_ID, token: TOKEN },
        env: { PATH: 'safe-path', CODEX_HOME: 'C:/codex' },
        launcher: { command: 'codex', prefix_args: [] },
        prepareCodexHome: async () => ({
          path: directory,
          cleanup: async () => {
            cleanupCalls += 1;
          },
        }),
        runProcess: async (input) => {
          calls.push(input);
          return calls.length === 1
            ? {
                stdout: initialOutput(),
                exitCode: 0,
                signal: null,
                timedOut: false,
                spawnError: false,
                truncated: false,
              }
            : {
                stdout: applyOutput(),
                exitCode: 0,
                signal: null,
                timedOut: false,
                spawnError: false,
                truncated: false,
              };
        },
        approve: async (summary, provenance) => {
          approvals.push({ summary, provenance });
          return true;
        },
        approvalProvenance: { source: 'test-caller', approval_id: digest('approval') },
        onValidatedToolCall: (call) => validated.push(call),
      });
      expect(result.status).toBe('complete');
      expect(result.session_digest).toBe(digest(THREAD_ID));
      expect(result).not.toHaveProperty('session_id');
      expect(calls).toHaveLength(2);
      expect(calls[0].args.at(-1)).toBe(REQUEST);
      expect(calls[1].args).toContain(THREAD_ID);
      expect(calls[1].args).not.toContain('--last');
      expect(calls[0].env).toEqual(calls[1].env);
      expect(calls[0].env.CODEX_HOME).toBe(directory);
      expect(cleanupCalls).toBe(1);
      expect(approvals[0].provenance.source).toBe('test-caller');
      expect(approvals[0].summary).not.toHaveProperty('plan_token');
      expect(approvals[0]).not.toHaveProperty('thread_id');
      expect(JSON.stringify(result)).not.toContain('opaque-plan-token');
      expect(result.initial_trace[0]).not.toHaveProperty('__raw');
      expect(result.trace.every((call) => !Object.hasOwn(call, '__raw'))).toBe(true);
      expect(validated.map((call) => call.tool)).toEqual([
        'build_discord_server',
        'guild_blueprint_apply',
        'guild_blueprint_evidence',
      ]);
      expect(validated[1].arguments.plan_token).toBe('opaque-plan-token-must-not-leak');
      expect(result).not.toHaveProperty('raw');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not resume when the caller rejects approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-live-reject-'));
    let processCalls = 0;
    let cleanupCalls = 0;
    try {
      const result = await runSmallModelLiveEvaluation({
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        cwd: 'C:/repo',
        stateDirectory: directory,
        target: { guildId: GUILD_ID, botId: BOT_ID, token: TOKEN },
        env: { PATH: 'safe-path' },
        launcher: { command: 'codex', prefix_args: [] },
        prepareCodexHome: async () => ({
          path: directory,
          cleanup: async () => {
            cleanupCalls += 1;
          },
        }),
        runProcess: async () => {
          processCalls += 1;
          return {
            stdout: initialOutput(),
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: false,
            truncated: false,
          };
        },
        approve: async () => false,
        approvalProvenance: { source: 'test-caller', approval_id: digest('approval') },
      });
      expect(result.status).toBe('not_approved');
      expect(result.session_digest).toBe(digest(THREAD_ID));
      expect(result).not.toHaveProperty('session_id');
      expect(cleanupCalls).toBe(1);
      expect(processCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits outside Codex for the exact bounded retry delay before resuming', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-live-retry-'));
    const waits = [];
    let processCalls = 0;
    try {
      const result = await runSmallModelLiveEvaluation({
        cliPath: 'C:/repo/packages/mcp-server/dist/cli.js',
        cwd: 'C:/repo',
        stateDirectory: directory,
        target: { guildId: GUILD_ID, botId: BOT_ID, token: TOKEN },
        env: { PATH: 'safe-path' },
        launcher: { command: 'codex', prefix_args: [] },
        prepareCodexHome: async () => ({ path: directory, cleanup: async () => {} }),
        runProcess: async () => {
          processCalls += 1;
          const stdout =
            processCalls === 1
              ? initialOutput()
              : processCalls === 2
                ? partialApplyOutput()
                : applyOutput();
          return {
            stdout,
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: false,
            truncated: false,
          };
        },
        sleep: async (milliseconds) => waits.push(milliseconds),
        approve: async () => true,
        approvalProvenance: { source: 'test-caller', approval_id: digest('approval') },
      });
      expect(result.status).toBe('complete');
      expect(result.external_wait_ms).toBe(37);
      expect(waits).toEqual([37]);
      expect(processCalls).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
