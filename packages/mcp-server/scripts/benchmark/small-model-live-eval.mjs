import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { assertSecretFreeJson } from './manifest.mjs';
import {
  buildCodexEnvironment,
  invocationArgs,
  resolveCodexLauncher,
  terminateCodexProcessTree,
} from './small-model-eval.mjs';

export const SMALL_MODEL_LIVE_SCHEMA = 'discord-mcp.small-model-live-eval.v1';
export const SMALL_MODEL_LIVE_MODEL = 'gpt-5.6-luna';
export const SMALL_MODEL_LIVE_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';

const execFile = promisify(nodeExecFile);
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 100_000;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_RESUME_TURNS = 8;
const DEFAULT_MAX_EXTERNAL_WAIT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_REF = /^dmbpr1\.[a-f0-9]{64}$/;
const SAFE_TOOL = /^[A-Za-z0-9_.-]{1,128}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const INITIAL_TOOLS = Object.freeze(['build_discord_server']);
const RESUME_TOOLS = Object.freeze(['guild_blueprint_apply', 'guild_blueprint_evidence']);
const RESUME_MODES = new Set(['combined', 'apply', 'evidence']);
const APPLY_STATUSES = new Set([
  'complete',
  'already_current',
  'partial',
  'busy',
  'blocked',
  'stale',
]);
const TERMINAL_APPLY_STATUSES = new Set(['complete', 'already_current']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function safeToolName(value) {
  return typeof value === 'string' && SAFE_TOOL.test(value) ? value : 'invalid_tool_name';
}

function safeId(value) {
  return typeof value === 'string' && (SNOWFLAKE.test(value) || DIGEST.test(value)) ? value : null;
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeString(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function safePlanRef(value) {
  return typeof value === 'string' && PLAN_REF.test(value) ? value : null;
}

function argumentProjection(value) {
  return {
    guild_id: safeId(value?.guild_id),
    expected_bot_id: safeId(value?.expected_bot_id),
    plan_id: safeId(value?.plan_id),
    approval_id: safeId(value?.approval_id),
    plan_ref: safePlanRef(value?.plan_ref),
  };
}

function exactUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new LiveEvalFailure(`${label}_INVALID`);
  return value;
}

function jsonArguments(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        value: null,
        argumentKeys: [],
        nestedArgumentKeys: [],
        requestDigest: null,
        targetTool: null,
        argumentProjection: argumentProjection(null),
      };
    }
  }
  if (!record(value)) {
    return {
      value: null,
      argumentKeys: [],
      nestedArgumentKeys: [],
      requestDigest: null,
      targetTool: null,
      argumentProjection: argumentProjection(null),
    };
  }
  const nested = record(value.args) ? value.args : null;
  const request =
    typeof value.request === 'string'
      ? value.request
      : typeof value.query === 'string'
        ? value.query
        : typeof nested?.request === 'string'
          ? nested.request
          : null;
  const targetTool =
    typeof value.tool === 'string'
      ? safeToolName(value.tool)
      : typeof nested?.tool === 'string'
        ? safeToolName(nested.tool)
        : null;
  return {
    value,
    argumentKeys: Object.keys(value).sort().slice(0, 64),
    nestedArgumentKeys: nested === null ? [] : Object.keys(nested).sort().slice(0, 64),
    requestDigest: request === null ? null : digest(request),
    targetTool,
    confirmed: value.__confirm === undefined ? null : value.__confirm === true,
    argumentProjection: argumentProjection(nested ?? value),
  };
}

function eventType(node, parentType = '') {
  return String(node?.type ?? parentType).toLowerCase();
}

function toolCandidate(event) {
  if (!record(event)) return null;
  const directType = eventType(event);
  const candidates = [
    [event, directType],
    [event.item, directType],
    [event.tool_call, directType],
    [event.toolCall, directType],
  ];
  for (const [node, parentType] of candidates) {
    if (!record(node)) continue;
    const type = eventType(node, parentType);
    if (!type.includes('mcp_tool') && !type.includes('tool_call')) continue;
    const name = node.name ?? node.tool ?? node.tool_name ?? node.function?.name;
    if (typeof name !== 'string') continue;
    const phase =
      directType.includes('completed') ||
      type.includes('completed') ||
      (directType === 'mcp_tool_call' && node.status === 'completed')
        ? 'completed'
        : 'started';
    return {
      callId:
        typeof (node.call_id ?? node.callId ?? node.item_id ?? node.id) === 'string'
          ? (node.call_id ?? node.callId ?? node.item_id ?? node.id)
          : null,
      name: safeToolName(name),
      args: node.arguments ?? node.input ?? node.args ?? node.parameters,
      result: node.result,
      toolError: node.error !== undefined && node.error !== null,
      phase,
    };
  }
  return null;
}

function projectResult(result) {
  if (!record(result)) return null;
  const data =
    (record(result.structured_content) && result.structured_content) ||
    (record(result.structuredContent) && result.structuredContent) ||
    (typeof result.status === 'string' && result) ||
    null;
  if (data === null) return null;
  const summary = {};
  if (typeof data.status === 'string') {
    if (
      [
        'ready',
        'already_current',
        'no_match',
        'blocked',
        ...APPLY_STATUSES,
        'verified',
        'drifted',
        'not_found',
      ].includes(data.status)
    ) {
      summary.status = data.status;
    }
  }
  if (record(data.target)) {
    const guildId = safeId(data.target.guild_id);
    const botId = safeId(data.target.bot_id);
    if (guildId !== null && botId !== null) summary.target = { guild_id: guildId, bot_id: botId };
  }
  for (const key of ['plan_id', 'blueprint_id', 'approval_id']) {
    const value = safeId(data[key]);
    if (value !== null) summary[key] = value;
  }
  const planRef = safePlanRef(data.plan_ref);
  if (planRef !== null) summary.plan_ref = planRef;
  // A digest of a raw token may be retained as initial evidence, but the raw
  // value is never projected into a trace, prompt, argv, or artifact.
  if (typeof data.plan_token === 'string') summary.plan_digest = digest(data.plan_token);
  const evidenceId = safeId(data.evidence_id);
  if (evidenceId !== null) summary.evidence_id = evidenceId;
  if (record(data.progress)) {
    const progress = {};
    for (const key of [
      'initial_planned',
      'planned_this_call',
      'attempted_this_call',
      'completed_total',
      'remaining',
      'checkpoint_version',
    ]) {
      if (Number.isSafeInteger(data.progress[key]) && data.progress[key] >= 0)
        progress[key] = data.progress[key];
    }
    if (Object.keys(progress).length > 0) summary.progress = progress;
  }
  if (record(data.evidence)) {
    const evidence = {};
    for (const key of ['identity_verified', 'guild_verified', 'checkpoint_persisted']) {
      if (typeof data.evidence[key] === 'boolean') evidence[key] = data.evidence[key];
    }
    if (['match', 'drift', 'not_run'].includes(data.evidence.readback))
      evidence.readback = data.evidence.readback;
    const evidenceId = safeId(data.evidence.activity?.evidence_id);
    if (evidenceId !== null) evidence.activity_evidence_id = evidenceId;
    if (Object.keys(evidence).length > 0) summary.evidence = evidence;
  }
  const verification = record(data.verification) ? data.verification : null;
  if (verification !== null || ['verified', 'drifted', 'not_found'].includes(data.status)) {
    summary.verification = {
      status: typeof data.status === 'string' ? data.status : null,
      readback: ['match', 'drift', 'not_run'].includes(verification?.readback)
        ? verification.readback
        : null,
      remaining: Array.isArray(verification?.remaining_operations)
        ? verification.remaining_operations.length
        : null,
      blockers: Array.isArray(verification?.blockers) ? verification.blockers.length : null,
      identity_verified:
        typeof verification?.identity_verified === 'boolean'
          ? verification.identity_verified
          : typeof data.evidence?.identity_verified === 'boolean'
            ? data.evidence.identity_verified
            : null,
      guild_verified:
        typeof verification?.guild_verified === 'boolean'
          ? verification.guild_verified
          : typeof data.evidence?.guild_verified === 'boolean'
            ? data.evidence.guild_verified
            : null,
    };
  }
  if (record(data.error)) {
    const error = {};
    const code = safeString(data.error.code);
    const retryAfterMs = safeNonnegativeInteger(data.error.retry_after_ms);
    if (code !== null) error.code = code;
    if (retryAfterMs !== null) error.retry_after_ms = retryAfterMs;
    if (Object.keys(error).length > 0) summary.error = error;
  }
  const nextAction = safeString(data.next_action);
  if (nextAction !== null) summary.next_action = nextAction;
  return Object.keys(summary).length === 0 ? null : summary;
}

function extractThreadId(event) {
  if (!record(event) || event.type !== 'thread.started') return null;
  return event.thread_id ?? null;
}

export class LiveEvalFailure extends Error {
  constructor(code, { diagnostic = null } = {}) {
    super(code);
    this.name = 'LiveEvalFailure';
    this.code = code;
    if (diagnostic !== null)
      this.diagnostic = assertSecretFreeJson(diagnostic, 'live_eval_failure_diagnostic');
  }
}

export function parseSmallModelLiveJsonl(stdout, { includeRaw = false } = {}) {
  if (typeof stdout !== 'string') throw new TypeError('Codex stdout must be a string');
  const calls = [];
  const byId = new Map();
  const pending = new Map();
  const contractErrors = [];
  const threadIds = new Set();
  let malformedJsonLines = 0;
  const lines = stdout.split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new LiveEvalFailure('JSONL_LINE_LIMIT');

  for (const line of lines) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedJsonLines += 1;
      continue;
    }
    if (!record(event)) continue;
    const threadId = extractThreadId(event);
    if (threadId !== null) {
      if (UUID.test(threadId)) threadIds.add(threadId);
      else contractErrors.push('thread_id_invalid');
    }
    const candidate = toolCandidate(event);
    if (candidate === null) continue;
    const parsed = jsonArguments(candidate.args);
    const baseKey = `${candidate.name}:${parsed.requestDigest ?? '-'}:${parsed.argumentKeys.join(',')}`;
    const key = candidate.callId ?? baseKey;
    let trace = candidate.callId
      ? byId.get(key)
      : candidate.phase === 'completed'
        ? pending.get(baseKey)?.shift()
        : undefined;
    if (trace === undefined) {
      trace = {
        tool: candidate.name,
        argument_keys: parsed.argumentKeys,
        ...(parsed.nestedArgumentKeys.length > 0
          ? { nested_argument_keys: parsed.nestedArgumentKeys }
          : {}),
        request_digest: parsed.requestDigest,
        argument_projection: parsed.argumentProjection,
        status: candidate.phase,
        ...(candidate.toolError ? { tool_error: true } : {}),
        ...(parsed.confirmed === null ? {} : { confirmed: parsed.confirmed }),
        ...(parsed.targetTool === null ? {} : { target_tool: parsed.targetTool }),
        _contract: {
          tool: candidate.name,
          argument_keys: parsed.argumentKeys,
          nested_argument_keys: parsed.nestedArgumentKeys,
          request_digest: parsed.requestDigest,
          argument_projection: parsed.argumentProjection,
          target_tool: parsed.targetTool,
        },
      };
      if (includeRaw)
        Object.defineProperty(trace, '__raw', {
          value: { arguments: parsed.value, result: candidate.result },
          enumerable: false,
          writable: true,
        });
      const resultSummary = projectResult(candidate.result);
      if (resultSummary !== null) trace.result_summary = resultSummary;
      calls.push(trace);
      if (candidate.callId) byId.set(key, trace);
      else if (candidate.phase === 'started') {
        const waiting = pending.get(baseKey) ?? [];
        waiting.push(trace);
        pending.set(baseKey, waiting);
      }
      continue;
    }
    if (candidate.phase !== 'completed') continue;
    const expected = trace._contract;
    if (
      expected.tool !== candidate.name ||
      JSON.stringify(expected.argument_keys) !== JSON.stringify(parsed.argumentKeys) ||
      JSON.stringify(expected.nested_argument_keys) !== JSON.stringify(parsed.nestedArgumentKeys) ||
      expected.request_digest !== parsed.requestDigest ||
      JSON.stringify(expected.argument_projection) !== JSON.stringify(parsed.argumentProjection) ||
      expected.target_tool !== parsed.targetTool
    ) {
      contractErrors.push('call_id_contract_mismatch');
      trace.contract_invalid = true;
    }
    trace.status = 'completed';
    if (candidate.toolError) trace.tool_error = true;
    if (parsed.requestDigest !== null) trace.request_digest = parsed.requestDigest;
    trace.argument_projection = parsed.argumentProjection;
    if (parsed.targetTool !== null) trace.target_tool = parsed.targetTool;
    if (parsed.confirmed !== null) trace.confirmed = parsed.confirmed;
    const resultSummary = projectResult(candidate.result);
    if (resultSummary !== null) trace.result_summary = resultSummary;
    if (includeRaw && trace.__raw) trace.__raw.result = candidate.result;
  }
  for (const call of calls) {
    if (call.status !== 'completed') {
      call.contract_invalid = true;
      contractErrors.push('tool_call_incomplete');
    }
  }
  const trace = calls.map((call) => {
    const { _contract: ignored, ...publicCall } = call;
    if (includeRaw)
      Object.defineProperty(publicCall, '__raw', {
        value: call.__raw,
        enumerable: false,
        writable: true,
      });
    return publicCall;
  });
  return {
    thread_id: threadIds.size === 1 ? [...threadIds][0] : null,
    thread_ids: [...threadIds],
    trace,
    malformed_json_lines: malformedJsonLines,
    contract_errors: [...contractErrors],
  };
}

function expectedTarget(target) {
  const guildId = target?.guildId ?? target?.guild_id;
  const botId = target?.botId ?? target?.bot_id;
  if (!record(target) || !SNOWFLAKE.test(guildId ?? '') || !SNOWFLAKE.test(botId ?? '')) {
    throw new TypeError('target guildId and botId are required');
  }
  return { guildId, botId, guild_id: guildId, bot_id: botId };
}

function controlledTarget(target) {
  if (!CONTROLLED_GUILD_IDS.includes(target.guildId) || target.botId !== CONTROLLED_BOT_ID)
    throw new TypeError('target must use a controlled guild and bot');
  return target;
}

function completed(trace) {
  return trace.filter((call) => call.status === 'completed');
}

function publicTrace(trace) {
  return trace.map((call) => ({ ...call }));
}

function validInitialTrace(parsed, target, request) {
  const calls = completed(parsed.trace);
  const summary = calls[0]?.result_summary;
  return (
    parsed.thread_id !== null &&
    parsed.thread_ids.length === 1 &&
    parsed.malformed_json_lines === 0 &&
    parsed.contract_errors.length === 0 &&
    parsed.trace.length === 1 &&
    calls.length === 1 &&
    calls[0].tool === 'build_discord_server' &&
    JSON.stringify(calls[0].argument_keys) === JSON.stringify(['request']) &&
    calls[0].request_digest === digest(request) &&
    summary?.target?.guild_id === target.guild_id &&
    summary?.target?.bot_id === target.bot_id &&
    safeId(summary?.plan_id) !== null &&
    safeId(summary?.blueprint_id) !== null &&
    safeId(summary?.approval_id) !== null &&
    PLAN_REF.test(summary?.plan_ref ?? '') &&
    ['ready', 'already_current'].includes(summary?.status)
  );
}

export function classifySmallModelLiveInitial({
  parsed,
  target,
  request,
  exitCode = 0,
  signal = null,
  timedOut = false,
  spawnError = false,
  truncated = false,
} = {}) {
  if (!record(parsed)) throw new TypeError('parsed result is required');
  if (spawnError || timedOut || truncated || signal !== null || exitCode !== 0)
    return 'host_invalid';
  if (!validInitialTrace(parsed, expectedTarget(target), request))
    return 'initial_contract_failure';
  return 'pass';
}

export function classifySmallModelLiveResume({
  parsed,
  sessionId,
  target,
  binding,
  trace = [],
} = {}) {
  if (
    !record(parsed) ||
    parsed.thread_id !== sessionId ||
    parsed.thread_ids.some((id) => id !== sessionId)
  )
    return 'session_mismatch';
  if (parsed.malformed_json_lines > 0 || parsed.contract_errors.length > 0)
    return 'tool_contract_failure';
  const all = [...trace, ...parsed.trace];
  const targetIds = controlledTarget(expectedTarget(target));
  const planId = binding?.plan_id ?? binding?.planId;
  const blueprintId = binding?.blueprint_id ?? binding?.blueprintId;
  const approvalId = binding?.approval_id ?? binding?.approvalId;
  const planRef = binding?.plan_ref ?? binding?.planRef;
  if (
    !DIGEST.test(planId ?? '') ||
    !DIGEST.test(blueprintId ?? '') ||
    !DIGEST.test(approvalId ?? '') ||
    !PLAN_REF.test(planRef ?? '')
  )
    return 'initial_binding_failure';
  const calls = completed(all);
  const newCalls = completed(parsed.trace);
  if (newCalls.some((call) => !RESUME_TOOLS.includes(call.tool))) return 'unsafe_tool_call';
  const applies = calls.filter((call) => call.tool === 'guild_blueprint_apply');
  const evidence = calls.filter((call) => call.tool === 'guild_blueprint_evidence');
  if (applies.length === 0) return 'model_no_apply_call';
  if (newCalls.filter((call) => call.tool === 'guild_blueprint_apply').length > 1)
    return 'apply_duplicate';
  if (evidence.length > 1) return 'evidence_duplicate';
  for (const call of applies) {
    const keys = new Set(call.argument_keys);
    if (
      !['approval_id', 'expected_bot_id', 'guild_id', 'plan_ref', '__confirm'].every((key) =>
        keys.has(key),
      )
    )
      return 'apply_contract_failure';
    if (keys.has('plan_token')) return 'apply_contract_failure';
    if (call.confirmed !== true) return 'apply_confirmation_failure';
    if (
      call.argument_projection?.guild_id !== targetIds.guild_id ||
      call.argument_projection?.expected_bot_id !== targetIds.bot_id
    )
      return 'apply_argument_target_mismatch';
    if (call.argument_projection?.approval_id !== approvalId)
      return 'apply_argument_approval_mismatch';
    if (call.argument_projection?.plan_ref !== planRef) return 'apply_argument_plan_ref_mismatch';
    if (call.tool_error === true) return 'apply_tool_error';
    if (
      call.result_summary?.target?.guild_id !== targetIds.guild_id ||
      call.result_summary?.target?.bot_id !== targetIds.bot_id
    )
      return 'apply_result_target_mismatch';
    if (
      call.result_summary?.plan_id !== planId ||
      call.result_summary?.blueprint_id !== blueprintId
    )
      return 'apply_result_binding_mismatch';
    if (!APPLY_STATUSES.has(call.result_summary?.status)) return 'apply_result_invalid';
  }
  const terminal = applies.some((call) => TERMINAL_APPLY_STATUSES.has(call.result_summary?.status));
  if (evidence.length > 0 && !terminal) return 'evidence_before_completion';
  for (const call of evidence) {
    if (
      call.argument_projection?.guild_id !== targetIds.guild_id ||
      call.argument_projection?.expected_bot_id !== targetIds.bot_id ||
      call.argument_projection?.plan_id !== planId
    )
      return 'evidence_binding_failure';
    if (
      call.result_summary?.target?.guild_id !== targetIds.guild_id ||
      call.result_summary?.target?.bot_id !== targetIds.bot_id ||
      call.result_summary?.plan_id !== planId ||
      call.result_summary?.blueprint_id !== blueprintId ||
      safeId(call.result_summary?.evidence_id) === null
    )
      return 'evidence_binding_failure';
    const verification = call.result_summary?.verification;
    if (
      call.result_summary?.status !== 'verified' ||
      verification?.status !== 'verified' ||
      verification?.readback !== 'match' ||
      verification?.remaining !== 0 ||
      verification?.blockers !== 0 ||
      verification?.identity_verified !== true ||
      verification?.guild_verified !== true
    )
      return 'evidence_verification_failure';
  }
  if (terminal && evidence.length === 1) return 'pass';
  if (applies.some((call) => ['stale', 'blocked'].includes(call.result_summary?.status)))
    return 'apply_terminal_failure';
  return 'resume_required';
}

function exactContinuationBinding(binding) {
  const normalized = {
    plan_id: binding?.plan_id ?? binding?.planId,
    blueprint_id: binding?.blueprint_id ?? binding?.blueprintId,
    approval_id: binding?.approval_id ?? binding?.approvalId,
    plan_ref: binding?.plan_ref ?? binding?.planRef,
  };
  if (
    !DIGEST.test(normalized.plan_id ?? '') ||
    !DIGEST.test(normalized.blueprint_id ?? '') ||
    !DIGEST.test(normalized.approval_id ?? '') ||
    !PLAN_REF.test(normalized.plan_ref ?? '')
  )
    throw new TypeError(
      'resume binding must contain exact plan, blueprint, approval IDs, and plan_ref',
    );
  return normalized;
}

function resumeFailureDiagnostic({ classification, turn, sessionId, target, binding, parsed }) {
  const targetIds = expectedTarget(target);
  const expected = exactContinuationBinding(binding);
  const apply = [...parsed.trace]
    .reverse()
    .find((call) => call.status === 'completed' && call.tool === 'guild_blueprint_apply');
  const argument = apply?.argument_projection ?? {};
  const result = apply?.result_summary ?? {};
  const resultTarget = result.target ?? {};
  const progress = result.progress ?? {};
  const diagnostic = {
    phase: 'resume',
    turn,
    classification,
    session_digest: digest(sessionId),
    tool: apply?.tool ?? null,
    call_count: parsed.trace.length,
    completed_call_count: completed(parsed.trace).length,
    confirmed: apply?.confirmed ?? null,
    tool_error: apply?.tool_error === true,
    expected: {
      guild_id: targetIds.guild_id,
      expected_bot_id: targetIds.bot_id,
      approval_id: expected.approval_id,
      plan_id: expected.plan_id,
      blueprint_id: expected.blueprint_id,
      plan_ref: expected.plan_ref,
    },
    observed: {
      guild_id: argument.guild_id ?? null,
      expected_bot_id: argument.expected_bot_id ?? null,
      approval_id: argument.approval_id ?? null,
      plan_ref: argument.plan_ref ?? null,
      result_guild_id: resultTarget.guild_id ?? null,
      result_bot_id: resultTarget.bot_id ?? null,
      result_plan_id: result.plan_id ?? null,
      result_blueprint_id: result.blueprint_id ?? null,
      status: APPLY_STATUSES.has(result.status) ? result.status : null,
      error_code:
        typeof result.error?.code === 'string' && SAFE_ERROR_CODE.test(result.error.code)
          ? result.error.code
          : null,
      completed_total: safeNonnegativeInteger(progress.completed_total),
      remaining: safeNonnegativeInteger(progress.remaining),
    },
    matches: {
      argument_guild: argument.guild_id === targetIds.guild_id,
      argument_bot: argument.expected_bot_id === targetIds.bot_id,
      argument_approval: argument.approval_id === expected.approval_id,
      argument_plan_ref: argument.plan_ref === expected.plan_ref,
      result_guild: resultTarget.guild_id === targetIds.guild_id,
      result_bot: resultTarget.bot_id === targetIds.bot_id,
      result_plan: result.plan_id === expected.plan_id,
      result_blueprint: result.blueprint_id === expected.blueprint_id,
    },
  };
  return assertSecretFreeJson(diagnostic, 'live_eval_failure_diagnostic');
}

function codexConfig({ cliPath, cwd, target, stateDirectory, enabledTools }) {
  const isInitialPhase = enabledTools.includes('build_discord_server');
  const developerInstructions = isInitialPhase
    ? 'On the initial turn only, fulfill the caller request by calling build_discord_server exactly once with the complete natural-language request. Do not answer without the tool call. Stop after the preview and do not apply changes. If this session is later resumed after explicit caller approval, follow the continuation-turn instructions; the initial-turn preview-only rule no longer applies.'
    : 'This is an explicitly approved continuation turn; the initial-turn preview-only rule no longer applies. Use only the explicitly enabled Discord tools. Do not replan or call tools outside the requested phase.';
  return [
    'model_reasoning_effort="low"',
    'features.shell_tool=false',
    'features.multi_agent=false',
    'features.apps=false',
    'web_search="disabled"',
    'tools.view_image=false',
    `developer_instructions=${JSON.stringify(developerInstructions)}`,
    `mcp_servers.discord_mcp.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.discord_mcp.args=${JSON.stringify([cliPath, 'serve'])}`,
    `mcp_servers.discord_mcp.cwd=${JSON.stringify(cwd)}`,
    'mcp_servers.discord_mcp.env_vars=["DISCORD_TOKEN"]',
    `mcp_servers.discord_mcp.env.ALLOWED_GUILDS=${JSON.stringify(target.guildId)}`,
    `mcp_servers.discord_mcp.env.DISCORD_DEFAULT_GUILD_ID=${JSON.stringify(target.guildId)}`,
    `mcp_servers.discord_mcp.env.DISCORD_EXPECTED_BOT_ID=${JSON.stringify(target.botId)}`,
    `mcp_servers.discord_mcp.env.MCP_DRY_RUN="false"`,
    `mcp_servers.discord_mcp.env.MCP_WRITE_MODE="allow"`,
    `mcp_servers.discord_mcp.env.MCP_TOOL_SURFACE=${JSON.stringify(isInitialPhase ? 'progressive' : 'full')}`,
    'mcp_servers.discord_mcp.env.MCP_AUDIT_ENABLED="true"',
    `mcp_servers.discord_mcp.env.MCP_BLUEPRINT_STATE_DIR=${JSON.stringify(stateDirectory)}`,
    `mcp_servers.discord_mcp.enabled_tools=${JSON.stringify(enabledTools)}`,
    'mcp_servers.discord_mcp.required=true',
    'mcp_servers.discord_mcp.startup_timeout_sec=60',
    'mcp_servers.discord_mcp.tool_timeout_sec=180',
    ...(enabledTools.includes('guild_blueprint_apply')
      ? ['mcp_servers.discord_mcp.tools.guild_blueprint_apply.approval_mode="approve"']
      : []),
  ];
}

export function buildSmallModelLiveArguments({
  phase,
  cliPath,
  cwd,
  target,
  stateDirectory,
  request = SMALL_MODEL_LIVE_REQUEST,
  sessionId = null,
  binding = null,
  resumeMode = 'combined',
} = {}) {
  if (!['initial', 'resume'].includes(phase))
    throw new TypeError('phase must be initial or resume');
  if (!RESUME_MODES.has(resumeMode)) throw new TypeError('resumeMode is invalid');
  if (phase === 'initial' && resumeMode !== 'combined')
    throw new TypeError('resumeMode is only valid for resume');
  if (typeof cliPath !== 'string' || typeof cwd !== 'string')
    throw new TypeError('cliPath and cwd are required');
  if (!isAbsolute(stateDirectory)) throw new TypeError('stateDirectory must be absolute');
  const targetIds = controlledTarget(expectedTarget(target));
  const continuation = phase === 'resume' ? exactContinuationBinding(binding) : null;
  if (phase === 'resume') exactUuid(sessionId, 'session_id');
  const enabledTools =
    phase === 'initial'
      ? INITIAL_TOOLS
      : resumeMode === 'apply'
        ? ['guild_blueprint_apply']
        : resumeMode === 'evidence'
          ? ['guild_blueprint_evidence']
          : RESUME_TOOLS;
  const args = [
    'exec',
    ...(phase === 'resume' ? ['resume'] : []),
    '--ignore-user-config',
    '--ignore-rules',
    '-m',
    SMALL_MODEL_LIVE_MODEL,
    '--skip-git-repo-check',
    '--json',
    ...(phase === 'initial' ? ['--sandbox', 'read-only', '--cd', cwd] : []),
    ...codexConfig({
      cliPath,
      cwd,
      target: targetIds,
      stateDirectory,
      enabledTools,
    }).flatMap((value) => ['-c', value]),
  ];
  if (phase === 'resume')
    args.push(
      sessionId,
      [
        'Approved by the caller. Continue the same plan.',
        'Use this exact non-secret continuation binding:',
        `guild_id=${targetIds.guild_id}`,
        `expected_bot_id=${targetIds.bot_id}`,
        `approval_id=${continuation.approval_id}`,
        `plan_id=${continuation.plan_id}`,
        `blueprint_id=${continuation.blueprint_id}`,
        `plan_ref=${continuation.plan_ref}`,
        resumeMode === 'evidence'
          ? 'Use the exact plan_id above for guild_blueprint_evidence.'
          : 'Use this exact plan_ref for guild_blueprint_apply. Do not alter, shorten, derive, or replace it.',
        resumeMode === 'apply'
          ? 'In this resume turn call exactly one guild_blueprint_apply with __confirm:true, then stop immediately after its result. Do not call guild_blueprint_evidence; the harness measures that separately. Do not replan.'
          : resumeMode === 'evidence'
            ? 'The approved apply is complete. In this resume turn call exactly one guild_blueprint_evidence for the exact plan_id, then stop. Do not call guild_blueprint_apply or replan.'
            : 'In this resume turn call exactly one guild_blueprint_apply with __confirm:true. If it returns partial or busy, stop immediately and do not call another apply or evidence; the harness will resume after the requested delay. After complete or already_current, call guild_blueprint_evidence exactly once. Do not replan.',
      ].join('\n'),
    );
  else args.push(request);
  return args;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function preparePrivateCodexHome({ env }) {
  const sourceHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const sourceAuth = join(sourceHome, 'auth.json');
  const privateHome = await mkdtemp(join(tmpdir(), 'discord-mcp-codex-home-'));
  try {
    await copyFile(sourceAuth, join(privateHome, 'auth.json'));
    await chmod(join(privateHome, 'auth.json'), 0o600);
    return {
      path: privateHome,
      cleanup: () => rm(privateHome, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(privateHome, { recursive: true, force: true });
    void error;
    throw new LiveEvalFailure('CODEX_AUTH_UNAVAILABLE');
  }
}

export async function runBoundedCodexProcess({
  launcher,
  args,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  spawn = nodeSpawn,
  terminate = terminateCodexProcessTree,
  sleep = wait,
  signal: abortSignal,
} = {}) {
  if (!record(launcher) || typeof launcher.command !== 'string')
    throw new TypeError('launcher is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1)
    throw new TypeError('terminationGraceMs must be positive');
  if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal))
    throw new TypeError('signal must be an AbortSignal');
  if (abortSignal?.aborted === true) {
    return {
      stdout: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      spawnError: false,
      truncated: false,
    };
  }
  return new Promise((resolveResult, rejectResult) => {
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = false;
    let settled = false;
    let stopPromise;
    let timer;
    let child;
    let resolveClosed;
    const closed = new Promise((resolveClose) => {
      resolveClosed = resolveClose;
    });
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolveResult({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        signal,
        timedOut,
        aborted,
        spawnError,
        truncated,
      });
    };
    const stop = ({ timeout = false, abort = false } = {}) => {
      if (timeout) timedOut = true;
      if (abort) aborted = true;
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        try {
          await terminate({ child, platform, force: false });
        } catch {
          // The close proof below remains authoritative.
        }
        const closedGracefully = await Promise.race([
          closed.then(() => true),
          sleep(terminationGraceMs).then(() => false),
        ]);
        if (!closedGracefully) {
          try {
            await terminate({ child, platform, force: true });
          } catch {
            // The close proof below remains authoritative.
          }
          const closedAfterForce = await Promise.race([
            closed.then(() => true),
            sleep(terminationGraceMs).then(() => false),
          ]);
          if (!closedAfterForce && !settled) {
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            rejectResult(new LiveEvalFailure('CODEX_PROCESS_DID_NOT_CLOSE'));
            return;
          }
        }
        finish(null, null);
      })();
      return stopPromise;
    };
    const onAbort = () => {
      void stop({ abort: true });
    };
    try {
      child = spawn(launcher.command, invocationArgs(launcher, args), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
    } catch {
      spawnError = true;
      finish(null, null);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes >= MAX_STDOUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_STDOUT_BYTES - bytes;
      const bounded = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(bounded);
      bytes += bounded.byteLength;
      if (bounded.byteLength < buffer.byteLength) truncated = true;
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => {
      spawnError = true;
      if (!timedOut) finish(null, null);
    });
    child.once('close', (code, signal) => {
      resolveClosed();
      finish(code, signal);
    });
    timer = setTimeout(() => void stop({ timeout: true }), timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted === true) onAbort();
  });
}

function hostFailure(result) {
  return (
    result.spawnError ||
    result.timedOut ||
    result.aborted ||
    result.truncated ||
    result.signal !== null ||
    result.exitCode !== 0
  );
}

export async function runSmallModelLiveEvaluation({
  cliPath,
  cwd,
  target,
  stateDirectory,
  env = process.env,
  request = SMALL_MODEL_LIVE_REQUEST,
  approve,
  approvalProvenance = null,
  launcher = null,
  resolveLauncher = resolveCodexLauncher,
  runProcess = runBoundedCodexProcess,
  run = execFile,
  spawn = nodeSpawn,
  terminate = terminateCodexProcessTree,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  platform = process.platform,
  maxResumeTurns = DEFAULT_MAX_RESUME_TURNS,
  maxExternalWaitMs = DEFAULT_MAX_EXTERNAL_WAIT_MS,
  sleep = wait,
  onValidatedToolCall = null,
  prepareCodexHome = preparePrivateCodexHome,
} = {}) {
  if (typeof approve !== 'function') throw new TypeError('approve callback is required');
  if (!isAbsolute(stateDirectory)) throw new TypeError('stateDirectory must be absolute');
  if (!record(approvalProvenance)) throw new TypeError('approvalProvenance is required');
  if (onValidatedToolCall !== null && typeof onValidatedToolCall !== 'function')
    throw new TypeError('onValidatedToolCall must be a function');
  if (!Number.isSafeInteger(maxExternalWaitMs) || maxExternalWaitMs < 0)
    throw new TypeError('maxExternalWaitMs must be nonnegative');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (typeof prepareCodexHome !== 'function')
    throw new TypeError('prepareCodexHome must be a function');
  await mkdir(stateDirectory, { recursive: true });
  assertSecretFreeJson(approvalProvenance, 'approval_provenance');
  const targetIds = controlledTarget(expectedTarget(target));
  const codexHome = await prepareCodexHome({ env, stateDirectory });
  if (!record(codexHome) || typeof codexHome.path !== 'string' || !isAbsolute(codexHome.path))
    throw new LiveEvalFailure('CODEX_HOME_INVALID');
  if (typeof codexHome.cleanup !== 'function')
    throw new LiveEvalFailure('CODEX_HOME_CLEANUP_MISSING');
  try {
    const childEnv = {
      ...buildCodexEnvironment(env, { token: target.token }),
      CODEX_HOME: codexHome.path,
    };
    const codexLauncher = launcher ?? (await resolveLauncher({ platform, run, env: childEnv }));
    const initialArgs = buildSmallModelLiveArguments({
      phase: 'initial',
      cliPath,
      cwd,
      target: targetIds,
      stateDirectory,
      request,
    });
    const initialResult = await runProcess({
      launcher: codexLauncher,
      args: initialArgs,
      cwd,
      env: childEnv,
      timeoutMs,
      platform,
      terminationGraceMs,
      spawn,
      terminate,
    });
    let initialParsed;
    try {
      initialParsed = parseSmallModelLiveJsonl(initialResult.stdout, { includeRaw: true });
    } catch {
      throw new LiveEvalFailure('INITIAL_JSONL_INVALID');
    }
    if (
      classifySmallModelLiveInitial({
        parsed: initialParsed,
        target: targetIds,
        request,
        ...initialResult,
      }) !== 'pass' ||
      hostFailure(initialResult)
    )
      throw new LiveEvalFailure('INITIAL_PHASE_FAILED');
    const initialSummary = initialParsed.trace[0].result_summary;
    const binding = {
      plan_id: initialSummary.plan_id,
      blueprint_id: initialSummary.blueprint_id,
      approval_id: initialSummary.approval_id,
      plan_ref: initialSummary.plan_ref,
    };
    if (onValidatedToolCall !== null)
      onValidatedToolCall({
        phase: 'initial',
        tool: 'build_discord_server',
        arguments: initialParsed.trace[0].__raw?.arguments,
        result: initialParsed.trace[0].__raw?.result,
      });
    const approval = await approve(
      {
        summary: initialSummary,
        session_digest: digest(initialParsed.thread_id),
      },
      approvalProvenance,
    );
    if (approval !== true)
      return assertSecretFreeJson(
        {
          schema_version: SMALL_MODEL_LIVE_SCHEMA,
          status: 'not_approved',
          approved: false,
          session_digest: digest(initialParsed.thread_id),
          initial_trace: publicTrace(initialParsed.trace),
          approval_provenance: approvalProvenance,
          external_wait_ms: 0,
        },
        'small_model_live_result',
      );

    let trace = [...initialParsed.trace];
    let lastParsed = null;
    let externalWaitMs = 0;
    for (let turn = 0; turn < maxResumeTurns; turn += 1) {
      const resumeArgs = buildSmallModelLiveArguments({
        phase: 'resume',
        cliPath,
        cwd,
        target: targetIds,
        stateDirectory,
        sessionId: initialParsed.thread_id,
        binding,
      });
      const result = await runProcess({
        launcher: codexLauncher,
        args: resumeArgs,
        cwd,
        env: childEnv,
        timeoutMs,
        platform,
        terminationGraceMs,
        spawn,
        terminate,
      });
      let parsed;
      try {
        parsed = parseSmallModelLiveJsonl(result.stdout, { includeRaw: true });
      } catch {
        throw new LiveEvalFailure('RESUME_JSONL_INVALID');
      }
      if (hostFailure(result)) throw new LiveEvalFailure('RESUME_HOST_FAILED');
      const classification = classifySmallModelLiveResume({
        parsed,
        sessionId: initialParsed.thread_id,
        target: targetIds,
        binding,
        trace,
      });
      if (classification === 'pass') {
        trace = [...trace, ...parsed.trace];
        for (const call of parsed.trace.filter((item) => item.status === 'completed')) {
          if (onValidatedToolCall !== null)
            onValidatedToolCall({
              phase: 'resume',
              tool: call.tool,
              arguments: call.__raw?.arguments,
              result: call.__raw?.result,
            });
        }
        return assertSecretFreeJson(
          {
            schema_version: SMALL_MODEL_LIVE_SCHEMA,
            status: 'complete',
            approved: true,
            session_digest: digest(initialParsed.thread_id),
            initial_trace: publicTrace(initialParsed.trace),
            trace: publicTrace(trace),
            approval_provenance: approvalProvenance,
            external_wait_ms: externalWaitMs,
          },
          'small_model_live_result',
        );
      }
      if (classification !== 'resume_required')
        throw new LiveEvalFailure(`RESUME_${classification.toUpperCase()}`, {
          diagnostic: resumeFailureDiagnostic({
            classification,
            turn: turn + 1,
            sessionId: initialParsed.thread_id,
            target: targetIds,
            binding,
            parsed,
          }),
        });
      for (const call of parsed.trace.filter((item) => item.status === 'completed')) {
        if (onValidatedToolCall !== null)
          onValidatedToolCall({
            phase: 'resume',
            tool: call.tool,
            arguments: call.__raw?.arguments,
            result: call.__raw?.result,
          });
      }
      const latestApply = [...parsed.trace]
        .reverse()
        .find((call) => call.status === 'completed' && call.tool === 'guild_blueprint_apply');
      const retryAfterMs = latestApply?.result_summary?.error?.retry_after_ms ?? 0;
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
        throw new LiveEvalFailure('RESUME_RETRY_DELAY_INVALID');
      if (externalWaitMs + retryAfterMs > maxExternalWaitMs)
        throw new LiveEvalFailure('RESUME_EXTERNAL_WAIT_LIMIT');
      await sleep(retryAfterMs);
      externalWaitMs += retryAfterMs;
      trace = [...trace, ...parsed.trace];
      lastParsed = parsed;
    }
    void lastParsed;
    throw new LiveEvalFailure('RESUME_TURN_LIMIT');
  } finally {
    await codexHome.cleanup();
  }
}
