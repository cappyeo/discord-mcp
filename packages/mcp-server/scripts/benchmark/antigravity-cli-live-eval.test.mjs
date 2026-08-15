import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_CLI_LIFECYCLE_TOOLS,
  buildAntigravityLiveArguments,
  classifyAntigravityInitial,
  classifyAntigravityResume,
  parseAntigravityLiveJsonl,
} from './antigravity-cli-live-eval.mjs';
import { MCP_CAPTURE_SCHEMA } from './mcp-capture-proxy.mjs';

const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const CONVERSATION_ID = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
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
    progress: {
      initial_planned: 42,
      planned_this_call: 42,
      attempted_this_call: 42,
      completed_total: 42,
      remaining: 0,
      checkpoint_version: 45,
    },
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
  if (phase === 'plan') {
    return {
      ...base,
      plan_id: data.plan_id,
      blueprint_id: data.blueprint_id,
      approval_id: data.approval_id,
      plan_ref: data.plan_ref,
    };
  }
  if (phase === 'apply') {
    return {
      ...base,
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
  }
  return {
    ...base,
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

function receiptText(data, phase) {
  return `Lifecycle result\nMCP_BLUEPRINT_RECEIPT ${JSON.stringify(receiptFor(data, phase))}`;
}

function stream({
  tool,
  output,
  conversationId = CONVERSATION_ID,
  status = 'SUCCESS',
  toolError = null,
  extraBeforeResult = [],
  extraAfterResult = [],
} = {}) {
  const events = [
    {
      event: 'init',
      conversation_id: conversationId,
      init: { cwd: 'C:/fixture', tools: ['call_mcp_tool'], permission_mode: 'request-review' },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 0,
        state: 'DONE',
        step_type: 'user_input',
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: { name: tool, parameters: {}, output, error: toolError },
      },
    },
    ...extraBeforeResult,
    {
      event: 'result',
      result: { conversation_id: conversationId, status, response: 'Done.' },
    },
    ...extraAfterResult,
  ];
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

describe('Antigravity CLI live lifecycle contract', () => {
  let root;
  let capturePath;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'discord-mcp-antigravity-live-'));
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
    return { capturePath, captureCursor: 0, text };
  }

  it('builds bounded initial and exact-conversation resume argv without a credential', () => {
    const initial = buildAntigravityLiveArguments({
      phase: 'initial',
      target: TARGET,
      request: REQUEST,
    });
    expect(initial).toContain('stream-json');
    expect(initial).toContain('--sandbox');
    expect(initial).toContain('--disable-slash-commands');
    expect(initial).toContain('170s');
    expect(initial.join('\n')).toContain(REQUEST);
    expect(initial.join('\n')).not.toContain('DISCORD_TOKEN');

    const resume = buildAntigravityLiveArguments({
      phase: 'resume',
      resumeMode: 'apply',
      sessionId: CONVERSATION_ID,
      target: TARGET,
      binding: BINDING,
    });
    expect(resume.slice(-2)).toEqual(['--conversation', CONVERSATION_ID]);
    expect(resume.join('\n')).toContain(`plan_ref=${PLAN_REF}`);
    expect(resume.join('\n')).toContain('__confirm:true');
  });

  it('joins the official stream to one authoritative private plan call', async () => {
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    const parsed = parseAntigravityLiveJsonl(
      stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, output: state.text }),
      {
        expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
        includeRaw: true,
        privateState: state,
      },
    );
    expect(parsed.conversation_id).toBe(CONVERSATION_ID);
    expect(parsed.trace).toHaveLength(1);
    expect(parsed.trace[0]).toMatchObject({
      tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      qualified_tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      argument_keys: ['request'],
      result_summary: receiptFor(planResult(), 'plan'),
    });
    expect(Object.keys(parsed.trace[0])).not.toContain('__raw');
    expect(parsed.trace[0].__raw.result.structuredContent).toEqual(planResult());
    expect(state.captureCursor).toBe(1);
    expect(classifyAntigravityInitial({ parsed, target: TARGET, request: REQUEST })).toBe('pass');
  });

  it('classifies exact apply and independently verified evidence turns', async () => {
    const applyArgs = {
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      approval_id: APPROVAL_ID,
      plan_ref: PLAN_REF,
      __confirm: true,
    };
    const applyState = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      applyArgs,
      applyResult(),
      'apply',
    );
    const apply = parseAntigravityLiveJsonl(
      stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply, output: applyState.text }),
      {
        expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
        expectedSessionId: CONVERSATION_ID,
        privateState: applyState,
      },
    );
    expect(
      classifyAntigravityResume({
        parsed: apply,
        sessionId: CONVERSATION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'apply',
      }),
    ).toBe('pass');

    const evidenceArgs = {
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      plan_id: PLAN_ID,
    };
    const evidenceState = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence,
      evidenceArgs,
      evidenceResult(),
      'evidence',
    );
    const evidence = parseAntigravityLiveJsonl(
      stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence, output: evidenceState.text }),
      {
        expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.evidence,
        expectedSessionId: CONVERSATION_ID,
        privateState: evidenceState,
      },
    );
    expect(
      classifyAntigravityResume({
        parsed: evidence,
        sessionId: CONVERSATION_ID,
        target: TARGET,
        binding: BINDING,
        resumeMode: 'evidence',
      }),
    ).toBe('pass');
  });

  it('projects the production apply progress, nested evidence id, and safe error receipt', async () => {
    const data = applyResult();
    data.status = 'partial';
    data.progress.remaining = 3;
    data.error = {
      code: 'DISCORD_RATE_LIMITED',
      operation_id: 'operation-17',
      retry_after_ms: 240_000,
      retriable: true,
    };
    data.evidence.activity = null;
    data.next_action = 'resume';
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      {
        guild_id: GUILD_ID,
        expected_bot_id: BOT_ID,
        approval_id: APPROVAL_ID,
        plan_ref: PLAN_REF,
        __confirm: true,
      },
      data,
      'apply',
    );
    const parsed = parseAntigravityLiveJsonl(
      stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply, output: state.text }),
      { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply, privateState: state },
    );
    expect(parsed.trace[0].result_summary).toMatchObject({
      status: 'partial',
      progress: { completed_total: 42, remaining: 3, checkpoint_version: 45 },
      error: { code: 'DISCORD_RATE_LIMITED', retry_after_ms: 240_000 },
      evidence_id: null,
      next_action: 'resume',
    });
  });

  it('fails closed on conversation drift and non-success terminal status', async () => {
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, output: state.text }),
        {
          expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          expectedSessionId: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
          privateState: state,
        },
      ),
    ).toThrow('SESSION_MISMATCH');
    expect(state.captureCursor).toBe(0);
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({
          tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          output: state.text,
          status: 'WAITING',
        }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RESULT_FAILURE');
  });

  it('rejects a second tool step and any event after the result', async () => {
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    const duplicate = {
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'call_mcp_tool',
        tool_info: {
          name: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          parameters: {},
          output: state.text,
          error: null,
        },
      },
    };
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({
          tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          output: state.text,
          extraBeforeResult: [duplicate],
        }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('TOOL_DUPLICATE');
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({
          tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          output: state.text,
          extraAfterResult: [duplicate],
        }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('EVENT_AFTER_RESULT');
  });

  it('rejects tool errors, wrong private tools, and raw plan tokens without consuming capture', async () => {
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({
          tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
          output: state.text,
          toolError: 'denied',
        }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('TOOL_ERROR');

    await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, output: state.text }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('CAPTURE_TOOL_MISMATCH');
    expect(state.captureCursor).toBe(0);

    const rawState = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply,
      { ...BINDING, plan_token: 'forbidden' },
      applyResult(),
      'apply',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply, output: rawState.text }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.apply, privateState: rawState },
      ),
    ).toThrow('RAW_PLAN_TOKEN');
    expect(rawState.captureCursor).toBe(0);
  });

  it('binds the host receipt to private text and structured content', async () => {
    const state = await privateState(
      ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
      { request: REQUEST },
      planResult(),
      'plan',
    );
    const changedHostReceipt = receiptText(
      { ...planResult(), plan_id: `sha256:${'0'.repeat(64)}` },
      'plan',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, output: changedHostReceipt }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RECEIPT_CAPTURE_MISMATCH');
    expect(state.captureCursor).toBe(0);

    const mismatched = planResult();
    const privateReceipt = receiptText(mismatched, 'plan');
    await writeFile(
      capturePath,
      `${JSON.stringify({
        schema_version: MCP_CAPTURE_SCHEMA,
        capture_id: 'capture-2',
        ordinal: 1,
        tool_name: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial,
        arguments: { request: REQUEST },
        result: {
          content: [{ type: 'text', text: privateReceipt }],
          structuredContent: { ...mismatched, approval_id: `sha256:${'9'.repeat(64)}` },
          isError: false,
        },
      })}\n`,
      'utf8',
    );
    expect(() =>
      parseAntigravityLiveJsonl(
        stream({ tool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, output: privateReceipt }),
        { expectedTool: ANTIGRAVITY_CLI_LIFECYCLE_TOOLS.initial, privateState: state },
      ),
    ).toThrow('RECEIPT_STRUCTURED_MISMATCH');
    expect(state.captureCursor).toBe(0);
  });
});
