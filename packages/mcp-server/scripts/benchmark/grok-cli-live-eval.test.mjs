import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildGrokCliLiveArguments,
  classifyGrokCliInitial,
  classifyGrokCliResume,
  GROK_CLI_LIFECYCLE_TOOLS,
  GROK_CLI_QUALIFIED_TOOLS,
  parseGrokCliLiveJsonl,
} from './grok-cli-live-eval.mjs';
import { MCP_CAPTURE_SCHEMA } from './mcp-capture-proxy.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SESSION_ID = '018f1f2e-7d52-4d28-8a38-b0da4c0a6f75';
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const BLUEPRINT_ID = `sha256:${'b'.repeat(64)}`;
const APPROVAL_ID = `sha256:${'c'.repeat(64)}`;
const PLAN_REF = `dmbpr1.${'d'.repeat(64)}`;
const EVIDENCE_ID = `sha256:${'e'.repeat(64)}`;
const REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';
const TARGET = { guildId: GUILD_ID, botId: BOT_ID };
const BINDING = {
  plan_id: PLAN_ID,
  blueprint_id: BLUEPRINT_ID,
  approval_id: APPROVAL_ID,
  plan_ref: PLAN_REF,
};

function dataFor(phase) {
  if (phase === 'plan')
    return {
      status: 'ready',
      target: { guild_id: GUILD_ID, bot_id: BOT_ID },
      plan_id: PLAN_ID,
      blueprint_id: BLUEPRINT_ID,
      approval_id: APPROVAL_ID,
      plan_ref: PLAN_REF,
    };
  if (phase === 'apply')
    return {
      status: 'complete',
      target: { guild_id: GUILD_ID, bot_id: BOT_ID },
      plan_id: PLAN_ID,
      blueprint_id: BLUEPRINT_ID,
      progress: { completed_total: 3, remaining: 0, checkpoint_version: 4 },
      error: null,
      evidence: { activity: { evidence_id: EVIDENCE_ID } },
      next_action: 'done',
    };
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
  const base = {
    schema_version: 'discord_mcp_blueprint_text_receipt.v1',
    phase,
    status: data.status,
    target: data.target,
  };
  if (phase === 'plan')
    return {
      ...base,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      approval_id: data.approval_id,
      plan_ref: data.plan_ref,
    };
  if (phase === 'apply')
    return {
      ...base,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      progress: data.progress,
      error: null,
      evidence_id: data.evidence.activity.evidence_id,
      next_action: data.next_action,
    };
  return {
    ...base,
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

function text(data, phase) {
  return `Lifecycle result\nMCP_BLUEPRINT_RECEIPT ${JSON.stringify(receipt(data, phase))}`;
}

function output(tool, args, data, phase) {
  const qualifiedTool = `discord-mcp__${tool}`;
  const events = [
    { type: 'thought', data: 'Discovering the requested Discord tool.' },
    {
      type: 'tool_call',
      toolCallId: 'search-1',
      toolName: 'search_tool',
      kind: 'other',
      status: 'in_progress',
      rawInput: { query: qualifiedTool, limit: 1 },
      content: [],
      locations: [],
    },
    {
      type: 'tool_call_update',
      toolCallId: 'search-1',
      status: 'completed',
      rawOutput: { tools: [{ name: qualifiedTool }] },
      content: [],
      locations: [],
    },
    {
      type: 'tool_call',
      toolCallId: 'use-1',
      toolName: 'use_tool',
      kind: 'other',
      status: 'in_progress',
      rawInput: { tool_name: qualifiedTool, tool_input: args },
      content: [],
      locations: [],
    },
    {
      type: 'tool_call_update',
      toolCallId: 'use-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: text(data, phase) }] },
      content: [],
      locations: [],
    },
    { type: 'text', data: 'Done.' },
    { type: 'end', stopReason: 'end_turn', sessionId: SESSION_ID, requestId: 'request-1' },
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

let root;
let capturePath;

describe('Grok CLI headless lifecycle contract', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'discord-mcp-grok-live-'));
    capturePath = join(root, 'capture.jsonl');
    await writeFile(capturePath, '', 'utf8');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function stateFor(tool, args, phase) {
    const data = dataFor(phase);
    await writeFile(
      capturePath,
      `${JSON.stringify({ schema_version: MCP_CAPTURE_SCHEMA, capture_id: 'capture-1', ordinal: 1, tool_name: tool, arguments: args, result: { content: [{ type: 'text', text: text(data, phase) }], structuredContent: data, isError: false } })}\n`,
      'utf8',
    );
    return { path: root, workspacePath: root, capturePath, captureCursor: 0 };
  }

  it('builds secret-free initial and exact-session resume arguments', () => {
    const state = { path: root, workspacePath: root };
    const initial = buildGrokCliLiveArguments({
      phase: 'initial',
      target: TARGET,
      request: REQUEST,
      privateState: state,
    });
    expect(initial).toContain('--output-format');
    expect(initial).toContain('streaming-json');
    expect(initial).toContain('--permission-mode');
    expect(initial).toContain('dontAsk');
    expect(initial).toContain('MCPTool(discord-mcp__build_discord_server)');
    expect(initial.slice(initial.indexOf('--tools'), initial.indexOf('--tools') + 2)).toEqual([
      '--tools',
      'search_tool,use_tool',
    ]);
    expect(initial).not.toContain('--always-approve');
    expect(initial).not.toContain('--disallowed-tools');
    expect(initial).toContain(root);
    expect(initial.join('\n')).toContain(REQUEST);
    expect(initial.join('\n')).not.toMatch(/DISCORD_TOKEN|GROK_API_KEY/u);
    const resume = buildGrokCliLiveArguments({
      phase: 'resume',
      resumeMode: 'apply',
      sessionId: SESSION_ID,
      target: TARGET,
      binding: BINDING,
      privateState: state,
    });
    expect(resume.slice(-2)).toEqual(['--resume', SESSION_ID]);
    expect(resume).toContain('MCPTool(discord-mcp__guild_blueprint_apply)');
    expect(resume.join('\n')).toContain(`plan_ref=${PLAN_REF}`);
  });

  it('accepts a plan call only when host output and private capture agree', async () => {
    const args = { request: REQUEST };
    const state = await stateFor(GROK_CLI_LIFECYCLE_TOOLS.initial, args, 'plan');
    const parsed = parseGrokCliLiveJsonl(
      output(GROK_CLI_LIFECYCLE_TOOLS.initial, args, dataFor('plan'), 'plan'),
      { expectedTool: GROK_CLI_QUALIFIED_TOOLS.initial, includeRaw: true, privateState: state },
    );
    expect(parsed.session_id).toBe(SESSION_ID);
    expect(parsed.trace).toHaveLength(1);
    expect(classifyGrokCliInitial({ parsed, target: TARGET, request: REQUEST })).toBe('pass');
  });

  it('enforces apply and evidence continuation bindings', async () => {
    const applyArgs = {
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      approval_id: APPROVAL_ID,
      plan_ref: PLAN_REF,
      __confirm: true,
    };
    const applyState = await stateFor(GROK_CLI_LIFECYCLE_TOOLS.apply, applyArgs, 'apply');
    const apply = parseGrokCliLiveJsonl(
      output(GROK_CLI_LIFECYCLE_TOOLS.apply, applyArgs, dataFor('apply'), 'apply'),
      {
        expectedTool: GROK_CLI_LIFECYCLE_TOOLS.apply,
        expectedSessionId: SESSION_ID,
        privateState: applyState,
      },
    );
    expect(
      classifyGrokCliResume({
        parsed: apply,
        sessionId: SESSION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'apply',
      }),
    ).toBe('pass');
    const evidenceArgs = { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID };
    const evidenceState = await stateFor(
      GROK_CLI_LIFECYCLE_TOOLS.evidence,
      evidenceArgs,
      'evidence',
    );
    const evidence = parseGrokCliLiveJsonl(
      output(GROK_CLI_LIFECYCLE_TOOLS.evidence, evidenceArgs, dataFor('evidence'), 'evidence'),
      {
        expectedTool: GROK_CLI_LIFECYCLE_TOOLS.evidence,
        expectedSessionId: SESSION_ID,
        privateState: evidenceState,
      },
    );
    expect(
      classifyGrokCliResume({
        parsed: evidence,
        sessionId: SESSION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'evidence',
      }),
    ).toBe('pass');
  });

  it('rejects raw legacy plan_token before consuming a capture', async () => {
    const args = { request: REQUEST, plan_token: 'dmbp1.secret' };
    const state = await stateFor(GROK_CLI_LIFECYCLE_TOOLS.initial, args, 'plan');
    expect(() =>
      parseGrokCliLiveJsonl(
        output(GROK_CLI_LIFECYCLE_TOOLS.initial, args, dataFor('plan'), 'plan'),
        { expectedTool: GROK_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RAW_PLAN_TOKEN');
    expect(state.captureCursor).toBe(0);
  });

  it('rejects an unapproved shell tool and duplicate calls', async () => {
    const events = [
      {
        type: 'tool_call',
        toolCallId: 'call-unsafe',
        toolName: 'bash',
        status: 'in_progress',
        rawInput: { command: 'echo unsafe' },
      },
      { type: 'end', stopReason: 'end_turn', sessionId: SESSION_ID },
    ];
    const state = { path: root, workspacePath: root, capturePath, captureCursor: 0 };
    expect(() =>
      parseGrokCliLiveJsonl(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
        expectedTool: GROK_CLI_LIFECYCLE_TOOLS.initial,
        privateState: state,
      }),
    ).toThrow('TOOL_UNAPPROVED');
  });

  it('rejects direct MCP calls and a search for a different integration tool', async () => {
    const args = { request: REQUEST };
    const state = await stateFor(GROK_CLI_LIFECYCLE_TOOLS.initial, args, 'plan');
    const direct = output(GROK_CLI_LIFECYCLE_TOOLS.initial, args, dataFor('plan'), 'plan').replace(
      '"toolName":"search_tool"',
      '"toolName":"discord-mcp__build_discord_server"',
    );
    expect(() =>
      parseGrokCliLiveJsonl(direct, {
        expectedTool: GROK_CLI_QUALIFIED_TOOLS.initial,
        privateState: state,
      }),
    ).toThrow('TOOL_UNAPPROVED');

    const wrongSearch = output(
      GROK_CLI_LIFECYCLE_TOOLS.initial,
      args,
      dataFor('plan'),
      'plan',
    ).replace('discord-mcp__build_discord_server', 'discord-mcp__messages_send');
    expect(() =>
      parseGrokCliLiveJsonl(wrongSearch, {
        expectedTool: GROK_CLI_QUALIFIED_TOOLS.initial,
        privateState: state,
      }),
    ).toThrow('TOOL_UNAPPROVED');
  });

  it('fails closed on argument drift and events after terminal end', async () => {
    const args = { request: REQUEST };
    const state = await stateFor(GROK_CLI_LIFECYCLE_TOOLS.initial, args, 'plan');
    const drifted = output(
      GROK_CLI_LIFECYCLE_TOOLS.initial,
      { request: 'different' },
      dataFor('plan'),
      'plan',
    );
    expect(() =>
      parseGrokCliLiveJsonl(drifted, {
        expectedTool: GROK_CLI_LIFECYCLE_TOOLS.initial,
        privateState: state,
      }),
    ).toThrow('ARGUMENT_CAPTURE_MISMATCH');
    expect(state.captureCursor).toBe(0);

    const withTrailingEvent = `${output(
      GROK_CLI_LIFECYCLE_TOOLS.initial,
      args,
      dataFor('plan'),
      'plan',
    )}${JSON.stringify({ type: 'text', data: 'late' })}\n`;
    expect(() =>
      parseGrokCliLiveJsonl(withTrailingEvent, {
        expectedTool: GROK_CLI_LIFECYCLE_TOOLS.initial,
        privateState: state,
      }),
    ).toThrow('EVENT_AFTER_END');
  });
});
