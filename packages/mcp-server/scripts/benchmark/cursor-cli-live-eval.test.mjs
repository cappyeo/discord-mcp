import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCursorCliLiveArguments,
  CURSOR_CLI_LIFECYCLE_TOOLS,
  classifyCursorCliInitial,
  classifyCursorCliResume,
  parseCursorCliLiveJsonl,
} from './cursor-cli-live-eval.mjs';
import { MCP_CAPTURE_SCHEMA } from './mcp-capture-proxy.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const SESSION_ID = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
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

function planResult() {
  return {
    status: 'ready',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    approval_id: APPROVAL_ID,
    plan_ref: PLAN_REF,
  };
}

function applyResult() {
  return {
    status: 'complete',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    progress: { completed_total: 42, remaining: 0, checkpoint_version: 45 },
    error: null,
    evidence: { activity: { evidence_id: EVIDENCE_ID } },
    next_action: 'done',
  };
}

function evidenceResult() {
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

function receiptFor(data, phase) {
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
      error: data.error,
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

function receiptText(data, phase) {
  return `Lifecycle result\nMCP_BLUEPRINT_RECEIPT ${JSON.stringify(receiptFor(data, phase))}`;
}

function stream({ tool, args, output, extra = [], completedArgs = args, terminal = 'success' }) {
  const callId = 'call_01';
  const descriptor = (actualArgs) => ({
    name: `discord-mcp-${tool}`,
    args: actualArgs,
    toolCallId: callId,
    providerIdentifier: 'discord-mcp',
    toolName: tool,
  });
  const events = [
    {
      type: 'system',
      subtype: 'init',
      cwd: root,
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
      tool_call: { mcpToolCall: { args: descriptor(args) } },
    },
    ...extra,
    {
      type: 'tool_call',
      subtype: 'completed',
      call_id: callId,
      session_id: SESSION_ID,
      is_error: false,
      tool_call: { mcpToolCall: { args: descriptor(completedArgs), result: output } },
    },
    {
      type: 'result',
      subtype: terminal,
      is_error: terminal !== 'success',
      result: 'done',
      session_id: SESSION_ID,
    },
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

let root;
let capturePath;

describe('Cursor Agent CLI live lifecycle contract', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'discord-mcp-cursor-live-'));
    capturePath = join(root, 'capture.jsonl');
    await writeFile(capturePath, '', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function privateState(tool, args, data, phase) {
    const text = receiptText(data, phase);
    await writeFile(
      capturePath,
      `${JSON.stringify({
        schema_version: MCP_CAPTURE_SCHEMA,
        capture_id: 'capture-1',
        ordinal: 1,
        tool_name: tool,
        arguments: args,
        result: {
          content: [{ type: 'text', text }],
          structuredContent: data,
          isError: false,
        },
      })}\n`,
      'utf8',
    );
    return { path: root, workspacePath: root, capturePath, captureCursor: 0, text };
  }

  it('builds a secret-free exact-workspace initial turn and exact-session resume', () => {
    const state = { path: root, workspacePath: root };
    const initial = buildCursorCliLiveArguments({
      phase: 'initial',
      target: TARGET,
      request: REQUEST,
      privateState: state,
    });
    expect(initial).toContain('stream-json');
    expect(initial).toContain('--workspace');
    expect(initial).toContain(root);
    expect(initial).toContain('--trust');
    expect(initial.join('\n')).not.toMatch(/DISCORD_TOKEN|CURSOR_API_KEY/u);
    const resume = buildCursorCliLiveArguments({
      phase: 'resume',
      resumeMode: 'apply',
      sessionId: SESSION_ID,
      target: TARGET,
      binding: BINDING,
      privateState: state,
    });
    expect(resume.slice(-2)).toEqual(['--resume', SESSION_ID]);
    expect(resume.join('\n')).toContain(`plan_ref=${PLAN_REF}`);
  });

  it('joins exact host arguments and receipt to one authoritative private plan call', async () => {
    const args = { request: REQUEST };
    const state = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      args,
      planResult(),
      'plan',
    );
    const parsed = parseCursorCliLiveJsonl(
      stream({ tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, args, output: state.text }),
      { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, includeRaw: true, privateState: state },
    );
    expect(parsed.session_id).toBe(SESSION_ID);
    expect(parsed.trace[0]).toMatchObject({
      tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      qualified_tool: 'discord-mcp:build_discord_server',
      argument_keys: ['request'],
      result_summary: receiptFor(planResult(), 'plan'),
    });
    expect(Object.keys(parsed.trace[0])).not.toContain('__raw');
    expect(parsed.trace[0].__raw.result.structuredContent).toEqual(planResult());
    expect(state.captureCursor).toBe(1);
    expect(classifyCursorCliInitial({ parsed, target: TARGET, request: REQUEST })).toBe('pass');
  });

  it('classifies exact apply and independently verified evidence', async () => {
    const applyArgs = {
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      approval_id: APPROVAL_ID,
      plan_ref: PLAN_REF,
      __confirm: true,
    };
    const applyState = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.apply,
      applyArgs,
      applyResult(),
      'apply',
    );
    const apply = parseCursorCliLiveJsonl(
      stream({ tool: CURSOR_CLI_LIFECYCLE_TOOLS.apply, args: applyArgs, output: applyState.text }),
      { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.apply, privateState: applyState },
    );
    expect(
      classifyCursorCliResume({
        parsed: apply,
        sessionId: SESSION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'apply',
      }),
    ).toBe('pass');

    const evidenceArgs = { guild_id: GUILD_ID, expected_bot_id: BOT_ID, plan_id: PLAN_ID };
    const evidenceState = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.evidence,
      evidenceArgs,
      evidenceResult(),
      'evidence',
    );
    const evidence = parseCursorCliLiveJsonl(
      stream({
        tool: CURSOR_CLI_LIFECYCLE_TOOLS.evidence,
        args: evidenceArgs,
        output: evidenceState.text,
      }),
      { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.evidence, privateState: evidenceState },
    );
    expect(
      classifyCursorCliResume({
        parsed: evidence,
        sessionId: SESSION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'evidence',
      }),
    ).toBe('pass');
  });

  it('fails closed on reconnect events, orphan completion, and unsuccessful terminal result', async () => {
    const args = { request: REQUEST };
    const state = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      args,
      planResult(),
      'plan',
    );
    const reconnect = { type: 'connection', subtype: 'reconnecting', session_id: SESSION_ID };
    expect(() =>
      parseCursorCliLiveJsonl(
        stream({
          tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
          args,
          output: state.text,
          extra: [reconnect],
        }),
        { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('EVENT_INVALID');
    expect(state.captureCursor).toBe(0);
    expect(() =>
      parseCursorCliLiveJsonl(
        stream({
          tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
          args,
          output: state.text,
          terminal: 'error',
        }),
        { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RESULT_FAILURE');
  });

  it('rejects host/capture argument drift and raw plan_token without consuming capture', async () => {
    const args = { request: REQUEST };
    const state = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      args,
      planResult(),
      'plan',
    );
    expect(() =>
      parseCursorCliLiveJsonl(
        stream({
          tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial,
          args,
          completedArgs: { request: `${REQUEST} drift` },
          output: state.text,
        }),
        { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('TOOL_ARGUMENT_DRIFT');
    const applyArgs = {
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      approval_id: APPROVAL_ID,
      plan_ref: PLAN_REF,
      plan_token: 'forbidden',
      __confirm: true,
    };
    const rawState = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.apply,
      applyArgs,
      applyResult(),
      'apply',
    );
    expect(() =>
      parseCursorCliLiveJsonl(
        stream({ tool: CURSOR_CLI_LIFECYCLE_TOOLS.apply, args: applyArgs, output: rawState.text }),
        { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.apply, privateState: rawState },
      ),
    ).toThrow('RAW_PLAN_TOKEN');
    expect(rawState.captureCursor).toBe(0);
  });

  it('rejects a model-visible receipt that differs from private structured MCP truth', async () => {
    const args = { request: REQUEST };
    const state = await privateState(
      CURSOR_CLI_LIFECYCLE_TOOLS.initial,
      args,
      planResult(),
      'plan',
    );
    const changed = receiptText({ ...planResult(), plan_id: `sha256:${'0'.repeat(64)}` }, 'plan');
    expect(() =>
      parseCursorCliLiveJsonl(
        stream({ tool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, args, output: changed }),
        { expectedTool: CURSOR_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RECEIPT_CAPTURE_MISMATCH');
    expect(state.captureCursor).toBe(0);
  });
});
