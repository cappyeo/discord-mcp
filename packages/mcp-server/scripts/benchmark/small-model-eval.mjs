import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { attestBuiltCli } from './build-attestation.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { assertSecretFreeJson } from './manifest.mjs';
import { openMcpBenchmarkSession } from './mcp-session.mjs';
import { createSmallModelIntegrity } from './small-model-attestation.mjs';

export const SMALL_MODEL_SCHEMA = 'discord-mcp.small-model-eval.v2';
export const SMALL_MODEL = 'gpt-5.6-luna';
export const SMALL_MODEL_REQUEST = 'Dựng cho tôi một server gaming chuyên nghiệp.';
export const DEFAULT_TRIALS = 5;
export const DEFAULT_PASS_THRESHOLD = 4;
export const ENABLED_TOOLS = Object.freeze([
  'build_discord_server',
  'mcp_tools_search',
  'mcp_tools_read',
]);
export const SMALL_MODEL_POLICY_VERSION = 'discord-mcp.small-model-policy.v1';
export const SMALL_MODEL_POLICY =
  'You are assisting in a Discord workspace. Treat an unqualified server as a Discord guild unless the user explicitly says VPS, hardware, or game hosting. For an architecture request, use the available architecture front door and complete one read-only tool call before replying. If that front door is unavailable, search the catalog once and invoke the single returned read-only match once. Never repeat an identical tool call. Never write or mutate anything without explicit user approval.';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 100_000;
const CODEX_PROBE_TIMEOUT_MS = 15_000;
const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_TERMINATION_COMMAND_TIMEOUT_MS = 5_000;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const TEMPLATE_CODE_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CLARIFICATION_PATTERNS = Object.freeze([
  /which kind of server/i,
  /what kind of server/i,
  /do you mean (?:a )?(?:vps|game hosting|hardware)/i,
  /bạn muốn dựng loại nào/i,
  /loại server nào/i,
  /vps|game hosting|physical server/i,
]);
const execFile = promisify(nodeExecFile);
const SAFE_CODEX_ENV_KEYS = Object.freeze([
  'APPDATA',
  'CI',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_COLOR',
  'PATH',
  'PROGRAMDATA',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'USERNAME',
]);
const REQUIRED_BLUEPRINT_COUNTS = Object.freeze([
  'roles',
  'categories',
  'channels',
  'onboarding_prompts',
  'automod_rules',
  'publications',
]);
// Keep this bounded vocabulary aligned with the production template recommender
// (`mcp-core/src/tools/templates/catalog/recommendation.ts` and `recommend.ts`).
const RECOMMENDATION_CAPABILITIES = new Set([
  'gaming',
  'community',
  'roleplay',
  'lfg',
  'platform',
  'staff',
  'support',
  'events',
  'technology',
  'learning',
  'art',
  'music',
  'voice',
  'forum',
]);
const STRUCTURAL_DIMENSIONS = new Set([
  'categories',
  'text_channels',
  'voice_channels',
  'forums',
  'stages',
  'custom_roles',
]);

const PREVIEW_ENVIRONMENT = Object.freeze({
  MCP_DRY_RUN: 'true',
  MCP_WRITE_MODE: 'preview',
  MCP_TOOL_SURFACE: 'progressive',
  MCP_AUDIT_ENABLED: 'false',
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : String(value);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeToolName(value) {
  return typeof value === 'string' && TOOL_NAME_RE.test(value) ? value : 'invalid_tool_name';
}

function eventType(node, parentType = '') {
  const value = typeof node?.type === 'string' ? node.type : parentType;
  return value.toLowerCase();
}

function isToolCallType(type) {
  return type === 'mcp_tool_call' || type.includes('mcp_tool') || type.includes('tool_call');
}

function candidateFromNode(node, parentType = '') {
  if (!record(node)) return null;
  const type = eventType(node, parentType);
  if (!isToolCallType(type)) return null;
  const name = node.name ?? node.tool ?? node.tool_name ?? node.function?.name;
  if (typeof name !== 'string') return null;
  const parent = parentType.toLowerCase();
  const phase =
    parent.includes('completed') ||
    (parent === '' && (type === 'mcp_tool_call' || node.status === 'completed')) ||
    (parent === '' && type.includes('result'))
      ? 'completed'
      : parent.includes('started') || type.includes('started') || type.includes('start')
        ? 'started'
        : 'completed';
  const args = node.arguments ?? node.input ?? node.args ?? node.parameters;
  return {
    callId:
      typeof (node.call_id ?? node.callId ?? node.item_id ?? node.id) === 'string'
        ? (node.call_id ?? node.callId ?? node.item_id ?? node.id)
        : null,
    name: safeToolName(name),
    args,
    result: node.result,
    phase,
  };
}

function findToolCall(event) {
  if (!record(event)) return null;
  return (
    candidateFromNode(event) ??
    candidateFromNode(event.item, event.type) ??
    candidateFromNode(event.tool_call, event.type) ??
    candidateFromNode(event.toolCall, event.type)
  );
}

function parseArguments(raw) {
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
      };
    }
  }
  if (!record(value))
    return {
      value: null,
      argumentKeys: [],
      nestedArgumentKeys: [],
      requestDigest: null,
      targetTool: null,
    };
  const nested = record(value.args) ? value.args : null;
  const requestValue =
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
    requestDigest: requestValue === null ? null : sha256(requestValue),
    targetTool,
  };
}

function safeSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : null;
}

function safeDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
}

function validBuildAttestation(value, commit) {
  const validFiles = (files, prefix, entrypoint, entryDigest) => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 256) return false;
    let previous = '';
    let entrypointCount = 0;
    for (const file of files) {
      if (
        !record(file) ||
        Object.keys(file).sort().join('\0') !== 'path\0sha256' ||
        typeof file.path !== 'string' ||
        !file.path.startsWith(prefix) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file.path.slice(prefix.length)) ||
        !safeDigest(file.sha256) ||
        (previous !== '' && file.path <= previous)
      )
        return false;
      previous = file.path;
      if (file.path === entrypoint) {
        entrypointCount += 1;
        if (file.sha256 !== entryDigest) return false;
      }
    }
    return entrypointCount === 1;
  };
  return (
    record(value) &&
    Object.keys(value).sort().join('\0') ===
      'core_entrypoint\0core_files\0core_sha256\0core_source_commit\0entrypoint\0files\0sha256\0source_commit' &&
    value.entrypoint === 'packages/mcp-server/dist/cli.js' &&
    safeDigest(value.sha256) !== null &&
    value.source_commit === commit &&
    value.core_entrypoint === 'packages/mcp-core/dist/index.js' &&
    safeDigest(value.core_sha256) !== null &&
    value.core_source_commit === commit &&
    validFiles(value.files, 'packages/mcp-server/dist/', value.entrypoint, value.sha256) &&
    validFiles(
      value.core_files,
      'packages/mcp-core/dist/',
      value.core_entrypoint,
      value.core_sha256,
    )
  );
}

function validTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export async function resolveCodexLauncher({
  platform = process.platform,
  run = execFile,
  environment,
  env,
} = {}) {
  const discoveryEnvironment = environment ?? env ?? process.env;
  if (!record(discoveryEnvironment)) throw new TypeError('Codex launcher environment is invalid');
  if (platform !== 'win32') {
    const result = await run('which', ['codex'], {
      encoding: 'utf8',
      env: discoveryEnvironment,
      maxBuffer: 64 * 1024,
      timeout: CODEX_PROBE_TIMEOUT_MS,
    });
    const selected = String(result?.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (selected === undefined || !isAbsolute(selected)) throw new Error('Codex CLI is unavailable');
    const command = resolve(await realpath(selected));
    const metadata = await lstat(command);
    if (!metadata.isFile()) throw new Error('Codex CLI is unavailable');
    return { command, prefix_args: [], kind: 'binary' };
  }
  for (const candidate of ['codex.exe', 'codex.ps1']) {
    try {
      const result = await run('where.exe', [candidate], {
        encoding: 'utf8',
        env: discoveryEnvironment,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        timeout: CODEX_PROBE_TIMEOUT_MS,
      });
      const path = String(result?.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (path === undefined) continue;
      if (candidate === 'codex.exe') return { command: path, prefix_args: [], kind: 'binary' };
      const nodeEntry = resolve(
        dirname(path),
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js',
      );
      try {
        const metadata = await lstat(nodeEntry);
        if (metadata.isFile()) {
          return { command: process.execPath, prefix_args: [nodeEntry], kind: 'node' };
        }
      } catch {
        // Fall back to the PowerShell shim when the npm entrypoint is packaged differently.
      }
      const powershell = String(
        (
          await run('where.exe', ['powershell.exe'], {
            encoding: 'utf8',
            env: discoveryEnvironment,
            windowsHide: true,
            maxBuffer: 64 * 1024,
            timeout: CODEX_PROBE_TIMEOUT_MS,
          })
        )?.stdout ?? '',
      )
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean);
      if (powershell === undefined || !isAbsolute(powershell)) continue;
      return {
        command: powershell,
        prefix_args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path,
        ],
        kind: 'powershell',
      };
    } catch {
      // Continue to the next supported Windows launcher.
    }
  }
  throw new Error('Codex CLI is unavailable');
}

export function invocationArgs(launcher, args) {
  if (!record(launcher) || !Array.isArray(launcher.prefix_args))
    throw new TypeError('invalid Codex launcher');
  return [...launcher.prefix_args, ...args];
}

export function buildCodexEnvironment(sourceEnv, target) {
  if (!record(sourceEnv) || !record(target))
    throw new TypeError('environment and target are required');
  const environment = {};
  for (const key of SAFE_CODEX_ENV_KEYS) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key] !== '')
      environment[key] = sourceEnv[key];
  }
  for (const key of ['CODEX_HOME', 'OPENAI_API_KEY']) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key] !== '')
      environment[key] = sourceEnv[key];
  }
  if (typeof target.token !== 'string' || target.token.length < 50)
    throw new Error('DISCORD_TOKEN is required');
  environment.DISCORD_TOKEN = target.token;
  return environment;
}

function safeTemplateCandidate(value) {
  if (!record(value) || !TEMPLATE_CODE_RE.test(String(value.code ?? ''))) return null;
  const provenance = record(value.provenance) ? value.provenance : {};
  const quality = record(value.quality) ? value.quality : {};
  const evidenceDigest = safeDigest(provenance.evidence_digest);
  const sourceGuild = record(provenance.source_guild) ? provenance.source_guild : {};
  if (
    evidenceDigest === null ||
    !validTimestamp(provenance.fetched_at) ||
    value.use_url !== `https://discord.new/${value.code}` ||
    quality.verified !== true ||
    quality.code_match !== true ||
    quality.permission_handling !== 'discarded_and_regenerated' ||
    !safeSnowflake(sourceGuild.id) ||
    (sourceGuild.snapshot_id !== null && typeof sourceGuild.snapshot_id !== 'string') ||
    (sourceGuild.icon_hash !== null && typeof sourceGuild.icon_hash !== 'string') ||
    (sourceGuild.preferred_locale !== null && typeof sourceGuild.preferred_locale !== 'string')
  ) {
    return null;
  }
  if (
    !Array.isArray(value.contributes) ||
    !Array.isArray(value.structural_contributions) ||
    new Set(value.contributes).size !== value.contributes.length ||
    new Set(value.structural_contributions).size !== value.structural_contributions.length ||
    value.contributes.some((item) => !RECOMMENDATION_CAPABILITIES.has(item)) ||
    value.structural_contributions.some((item) => !STRUCTURAL_DIMENSIONS.has(item))
  ) {
    return null;
  }
  return {
    code: value.code,
    use_url: value.use_url,
    verified: quality.verified === true,
    code_match: quality.code_match === true,
    permission_handling: 'discarded_and_regenerated',
    contributes: [...value.contributes],
    structural_contributions: [...value.structural_contributions],
    evidence_digest: evidenceDigest,
    fetched_at: provenance.fetched_at,
    source_guild: {
      id: sourceGuild.id,
      snapshot_id: sourceGuild.snapshot_id,
      icon_hash: sourceGuild.icon_hash,
      preferred_locale: sourceGuild.preferred_locale,
    },
  };
}

/** Keep only bounded plan evidence; Discord result bodies and plan tokens never cross this boundary. */
function summarizeToolResult(result) {
  if (!record(result)) return null;
  const data = record(result.structured_content)
    ? result.structured_content
    : record(result.structuredContent)
      ? result.structuredContent
      : record(result.status)
        ? result
        : null;
  if (data === null) return null;
  const summary = {};
  if (['ready', 'already_current', 'blocked', 'no_match'].includes(data.status)) {
    summary.status = data.status;
  }
  if (record(data.target)) {
    const guildId = safeSnowflake(data.target.guild_id);
    const botId = safeSnowflake(data.target.bot_id);
    if (guildId !== null && botId !== null) summary.target = { guild_id: guildId, bot_id: botId };
  }
  const blueprint = record(data.blueprint) ? data.blueprint : {};
  const planSummary = record(data.summary) ? data.summary : {};
  const counts = {};
  for (const [key, value] of Object.entries({
    roles: Array.isArray(blueprint.roles) ? blueprint.roles.length : planSummary.roles,
    categories: Array.isArray(blueprint.categories)
      ? blueprint.categories.length
      : planSummary.categories,
    channels: Array.isArray(blueprint.channels) ? blueprint.channels.length : planSummary.channels,
    onboarding_prompts: Array.isArray(blueprint.onboarding?.prompts)
      ? blueprint.onboarding.prompts.length
      : planSummary.onboarding_prompts,
    automod_rules: Array.isArray(blueprint.automod?.rules)
      ? blueprint.automod.rules.length
      : planSummary.automod_rules,
    publications: Array.isArray(blueprint.components_v2?.publications)
      ? blueprint.components_v2.publications.length
      : planSummary.publications,
    operations: planSummary.total_operations,
  })) {
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  if (Object.keys(counts).length > 0) summary.counts = counts;
  const verification = record(data.verification) ? data.verification : {};
  const blueprintSafety = record(blueprint.safety) ? blueprint.safety : {};
  const safety = {};
  for (const key of [
    'blueprint_validation',
    'target_readback',
    'source_permissions_discarded',
    'source_overwrites_discarded',
    'severe_generated_role_permissions',
    'dangling_symbolic_references',
    'onboarding_requirements_met',
    'components_v2_pre_resolution_valid',
  ]) {
    const value = blueprintSafety[key] ?? verification[key];
    if (
      typeof value === 'boolean' ||
      Number.isSafeInteger(value) ||
      value === 'passed' ||
      value === 'not_run'
    )
      safety[key] = value;
  }
  if (Object.keys(safety).length > 0) summary.safety = safety;
  const source = record(data.source) ? data.source : {};
  const primary = safeTemplateCandidate(source.primary);
  const rawInspirations = source.inspirations;
  const inspirations =
    Array.isArray(rawInspirations) && rawInspirations.length <= 3
      ? rawInspirations.map(safeTemplateCandidate)
      : null;
  if (
    typeof source.catalog_version === 'string' &&
    source.catalog_version.trim() !== '' &&
    source.permission_policy === 'discard_source_and_regenerate' &&
    primary !== null &&
    inspirations !== null &&
    inspirations.length <= 3 &&
    inspirations.every((candidate) => candidate !== null)
  ) {
    summary.template_evidence = {
      catalog_version: source.catalog_version,
      permission_policy: source.permission_policy,
      primary,
      inspirations,
    };
  }
  return Object.keys(summary).length === 0 ? null : summary;
}

function assistantText(event) {
  if (!record(event)) return '';
  const item = record(event.item) ? event.item : null;
  const type = `${String(event.type ?? '').toLowerCase()} ${String(item?.type ?? '').toLowerCase()}`;
  if (!type.includes('message') && !type.includes('response')) return '';
  const value =
    event.text ?? event.message ?? event.content ?? item?.text ?? item?.message ?? item?.content;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string'
          ? part
          : record(part) && typeof part.text === 'string'
            ? part.text
            : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function asksServerTypeClarification(text) {
  return typeof text === 'string' && CLARIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

function usageFrom(event) {
  const usage = record(event?.usage)
    ? event.usage
    : record(event?.item?.usage)
      ? event.item.usage
      : null;
  if (!usage) return null;
  const result = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens']) {
    const value = integer(usage[key]);
    if (value !== null) result[key] = value;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/** Parse Codex JSONL into a deliberately lossy, secret-free tool trace. */
export function parseCodexJsonl(stdout) {
  if (typeof stdout !== 'string') throw new TypeError('Codex stdout must be a string');
  const calls = [];
  const byId = new Map();
  const pendingWithoutId = new Map();
  let malformedJsonLines = 0;
  const contractErrors = [];
  let clarification = false;
  let usage = null;
  const lines = stdout.split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new Error('Codex output exceeded line bound');

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
    const eventUsage = usageFrom(event);
    if (eventUsage) usage = eventUsage;
    if (asksServerTypeClarification(assistantText(event))) clarification = true;
    const candidate = findToolCall(event);
    if (!candidate) continue;
    const parsed = parseArguments(candidate.args);
    const requestDigest = parsed.requestDigest;
    const baseKey = `${candidate.name}:${requestDigest ?? '-'}:${parsed.argumentKeys.join(',')}`;
    const key = candidate.callId ?? baseKey;
    let trace = candidate.callId
      ? byId.get(key)
      : candidate.phase === 'completed'
        ? pendingWithoutId.get(baseKey)?.shift()
        : undefined;
    if (trace === undefined) {
      trace = {
        tool: candidate.name,
        argument_keys: parsed.argumentKeys,
        ...(parsed.nestedArgumentKeys.length > 0
          ? { nested_argument_keys: parsed.nestedArgumentKeys }
          : {}),
        request_digest: requestDigest,
        status: candidate.phase,
        ...(parsed.targetTool === null ? {} : { target_tool: parsed.targetTool }),
        _contract: {
          tool: candidate.name,
          argument_keys: parsed.argumentKeys,
          nested_argument_keys: parsed.nestedArgumentKeys,
          request_digest: requestDigest,
          target_tool: parsed.targetTool,
        },
      };
      const resultSummary = summarizeToolResult(candidate.result);
      if (resultSummary !== null) trace.result_summary = resultSummary;
      calls.push(trace);
      if (candidate.callId) byId.set(key, trace);
      else if (candidate.phase === 'started') {
        const pending = pendingWithoutId.get(baseKey) ?? [];
        pending.push(trace);
        pendingWithoutId.set(baseKey, pending);
      }
    } else if (candidate.phase === 'completed') {
      const expected = trace._contract;
      const actual = {
        tool: candidate.name,
        argument_keys: parsed.argumentKeys,
        nested_argument_keys: parsed.nestedArgumentKeys,
        request_digest: requestDigest,
        target_tool: parsed.targetTool,
      };
      if (
        expected !== undefined &&
        (expected.tool !== actual.tool ||
          JSON.stringify(expected.argument_keys) !== JSON.stringify(actual.argument_keys) ||
          JSON.stringify(expected.nested_argument_keys) !==
            JSON.stringify(actual.nested_argument_keys) ||
          expected.request_digest !== actual.request_digest ||
          expected.target_tool !== actual.target_tool)
      ) {
        contractErrors.push('call_id_contract_mismatch');
        trace.contract_invalid = true;
      }
      trace.status = 'completed';
      if (requestDigest !== null) trace.request_digest = requestDigest;
      if (parsed.targetTool !== null) trace.target_tool = parsed.targetTool;
      const resultSummary = summarizeToolResult(candidate.result);
      if (resultSummary !== null) trace.result_summary = resultSummary;
      if (!candidate.callId && pendingWithoutId.get(baseKey)?.length === 0) {
        pendingWithoutId.delete(baseKey);
      }
    }
  }
  return {
    trace: calls.map((call) => {
      const { _contract: ignored, ...publicCall } = call;
      return publicCall;
    }),
    malformed_json_lines: malformedJsonLines,
    contract_errors: [...contractErrors],
    clarification_detected: clarification,
    usage: usage ?? {},
  };
}

export function parseCodexTrialOutput(stdout) {
  try {
    return { parsed: parseCodexJsonl(stdout), parse_failed: false };
  } catch {
    return {
      parsed: {
        trace: [],
        malformed_json_lines: 0,
        contract_errors: ['parser_failure'],
        clarification_detected: false,
        usage: {},
      },
      parse_failed: true,
    };
  }
}

function hasExactRequest(call, request) {
  return call.request_digest === sha256(request);
}

function validPositiveCounts(counts) {
  return (
    record(counts) &&
    REQUIRED_BLUEPRINT_COUNTS.every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] > 0,
    ) &&
    Number.isSafeInteger(counts.operations) &&
    counts.operations >= 0
  );
}

function validPlanEvidence(summary, target) {
  if (!record(summary) || !['ready', 'already_current'].includes(summary.status)) return false;
  if (
    target !== null &&
    (summary.target?.guild_id !== target.guildId || summary.target?.bot_id !== target.botId)
  ) {
    return false;
  }
  if (!validPositiveCounts(summary.counts)) return false;
  const safety = summary.safety;
  if (
    !record(safety) ||
    safety.blueprint_validation !== 'passed' ||
    safety.target_readback !== 'passed' ||
    safety.source_permissions_discarded !== true ||
    safety.source_overwrites_discarded !== true ||
    safety.severe_generated_role_permissions !== 0 ||
    safety.dangling_symbolic_references !== 0 ||
    safety.onboarding_requirements_met !== true ||
    safety.components_v2_pre_resolution_valid !== true
  ) {
    return false;
  }
  const template = summary.template_evidence;
  if (!record(template) || !record(template.primary) || !Array.isArray(template.inspirations)) {
    return false;
  }
  const candidates = [template.primary, ...template.inspirations];
  const validContributionArrays = (candidate) =>
    Array.isArray(candidate.contributes) &&
    Array.isArray(candidate.structural_contributions) &&
    new Set(candidate.contributes).size === candidate.contributes.length &&
    new Set(candidate.structural_contributions).size ===
      candidate.structural_contributions.length &&
    candidate.contributes.every((item) => RECOMMENDATION_CAPABILITIES.has(item)) &&
    candidate.structural_contributions.every((item) => STRUCTURAL_DIMENSIONS.has(item));
  return (
    typeof template.catalog_version === 'string' &&
    template.catalog_version.trim() !== '' &&
    template.permission_policy === 'discard_source_and_regenerate' &&
    template.inspirations.length <= 3 &&
    validContributionArrays(template.primary) &&
    (template.primary.contributes.length > 0 ||
      template.primary.structural_contributions.length > 0) &&
    new Set(candidates.map((candidate) => candidate.code)).size === candidates.length &&
    template.inspirations.every(
      (candidate) =>
        validContributionArrays(candidate) &&
        (candidate.contributes.length > 0 || candidate.structural_contributions.length > 0),
    ) &&
    candidates.every(
      (candidate) =>
        validContributionArrays(candidate) &&
        candidate.verified === true &&
        candidate.code_match === true &&
        candidate.permission_handling === 'discarded_and_regenerated' &&
        candidate.use_url === `https://discord.new/${candidate.code}` &&
        safeDigest(candidate.evidence_digest) !== null &&
        validTimestamp(candidate.fetched_at) &&
        safeSnowflake(candidate.source_guild?.id) !== null,
    )
  );
}

/** Classify a sanitized trace without inspecting model text, tool results, or credentials. */
export function classifySmallModelTrial({
  trace,
  malformedJsonLines = 0,
  contractErrors = [],
  clarificationDetected = false,
  exitCode = 0,
  signal = null,
  timedOut = false,
  spawnError = false,
  truncated = false,
  target = null,
  request = SMALL_MODEL_REQUEST,
  frontDoorAvailable = true,
} = {}) {
  if (!Array.isArray(trace)) throw new TypeError('trace must be an array');
  if (!frontDoorAvailable) return 'product_front_door_missing';
  if (spawnError || timedOut || truncated || signal !== null || exitCode !== 0)
    return 'host_invalid';
  if (!Array.isArray(contractErrors) || contractErrors.length > 0) return 'tool_contract_failure';
  if (trace.some((call) => call?.contract_invalid === true)) return 'tool_contract_failure';
  if (trace.some((call) => !ENABLED_TOOLS.includes(call.tool))) return 'unsafe_tool_call';
  const completed = trace.filter((call) => call.status === 'completed');
  if (completed.length === 0)
    return trace.length === 0 ? 'model_no_tool_call' : 'tool_contract_failure';
  if (clarificationDetected) return 'planner_failure';
  if (malformedJsonLines > 0) return 'tool_contract_failure';

  if (completed.length === 1 && completed[0].tool === 'build_discord_server') {
    const summary = completed[0].result_summary;
    return hasExactRequest(completed[0], request) &&
      JSON.stringify(completed[0].argument_keys) === JSON.stringify(['request']) &&
      trace.length === 1 &&
      validPlanEvidence(summary, target) &&
      ((summary.status === 'ready' && summary.counts.operations > 0) ||
        (summary.status === 'already_current' && summary.counts.operations === 0))
      ? 'pass'
      : 'tool_contract_failure';
  }

  if (
    completed.length === 2 &&
    trace.length === 2 &&
    completed[0].tool === 'mcp_tools_search' &&
    completed[1].tool === 'mcp_tools_read' &&
    completed[0].argument_keys.includes('query') &&
    completed[0].argument_keys.every((key) => key === 'query' || key === 'limit') &&
    completed[1].argument_keys.length === 2 &&
    completed[1].argument_keys.includes('args') &&
    completed[1].argument_keys.includes('tool') &&
    JSON.stringify(completed[1].nested_argument_keys) === JSON.stringify(['request']) &&
    completed[1].target_tool === 'build_discord_server' &&
    hasExactRequest(completed[0], request) &&
    hasExactRequest(completed[1], request) &&
    validPlanEvidence(completed[1].result_summary, target) &&
    ((completed[1].result_summary.status === 'ready' &&
      completed[1].result_summary.counts.operations > 0) ||
      (completed[1].result_summary.status === 'already_current' &&
        completed[1].result_summary.counts.operations === 0))
  ) {
    return 'pass';
  }
  return 'tool_contract_failure';
}

function hostDiagnostics({ exitCode, signal, timedOut, spawnError, stdoutTruncated } = {}) {
  const diagnostics = [];
  if (spawnError) diagnostics.push('host_spawn_error');
  if (timedOut) diagnostics.push('host_timeout');
  if (stdoutTruncated) diagnostics.push('host_stdout_truncated');
  if (typeof signal === 'string' && signal !== '') diagnostics.push('host_signal');
  if (Number.isInteger(exitCode) && exitCode !== 0) diagnostics.push('host_nonzero_exit');
  return diagnostics;
}

export function buildCodexArguments({ cliPath, cwd, target, policy = SMALL_MODEL_POLICY } = {}) {
  if (typeof cliPath !== 'string' || typeof cwd !== 'string')
    throw new TypeError('cliPath and cwd are required');
  if (!record(target)) throw new TypeError('target is required');
  const config = [
    'model_reasoning_effort="low"',
    'features.shell_tool=false',
    'features.multi_agent=false',
    'features.apps=false',
    'web_search="disabled"',
    'tools.view_image=false',
    'history.persistence="none"',
    `developer_instructions=${JSON.stringify(policy)}`,
    `mcp_servers.discord_mcp.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.discord_mcp.args=${JSON.stringify([cliPath, 'serve'])}`,
    `mcp_servers.discord_mcp.cwd=${JSON.stringify(cwd)}`,
    'mcp_servers.discord_mcp.env_vars=["DISCORD_TOKEN"]',
    `mcp_servers.discord_mcp.env.ALLOWED_GUILDS=${JSON.stringify(target.guildId)}`,
    `mcp_servers.discord_mcp.env.DISCORD_DEFAULT_GUILD_ID=${JSON.stringify(target.guildId)}`,
    `mcp_servers.discord_mcp.env.DISCORD_EXPECTED_BOT_ID=${JSON.stringify(target.botId)}`,
    'mcp_servers.discord_mcp.env.MCP_DRY_RUN="true"',
    'mcp_servers.discord_mcp.env.MCP_WRITE_MODE="preview"',
    'mcp_servers.discord_mcp.env.MCP_TOOL_SURFACE="progressive"',
    'mcp_servers.discord_mcp.env.MCP_AUDIT_ENABLED="false"',
    `mcp_servers.discord_mcp.enabled_tools=${JSON.stringify([...ENABLED_TOOLS])}`,
    'mcp_servers.discord_mcp.required=true',
    'mcp_servers.discord_mcp.startup_timeout_sec=60',
  ];
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '-m',
    SMALL_MODEL,
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--json',
    '--cd',
    cwd,
    ...config.flatMap((value) => ['-c', value]),
    SMALL_MODEL_REQUEST,
  ];
}

function targetFromEnvironment(env) {
  const token = env.DISCORD_TOKEN;
  if (typeof token !== 'string' || token.length < 50) throw new Error('DISCORD_TOKEN is required');
  const allowed =
    typeof env.ALLOWED_GUILDS === 'string'
      ? env.ALLOWED_GUILDS.split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
  const guildId = env.DISCORD_DEFAULT_GUILD_ID ?? (allowed.length === 1 ? allowed[0] : undefined);
  const botId = env.DISCORD_EXPECTED_BOT_ID;
  if (!/^\d{17,20}$/.test(guildId ?? '') || !/^\d{17,20}$/.test(botId ?? '')) {
    throw new Error('DISCORD_DEFAULT_GUILD_ID and DISCORD_EXPECTED_BOT_ID are required');
  }
  if (!CONTROLLED_GUILD_IDS.includes(guildId) || botId !== CONTROLLED_BOT_ID) {
    throw new Error('small-model target is outside the controlled guild/bot scope');
  }
  return { token, guildId, botId };
}

async function safeOutputPath(output) {
  if (typeof output !== 'string' || !isAbsolute(output))
    throw new Error('--output must be an absolute path');
  const target = resolve(output);
  const rel = relative(REPO_ROOT, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw new Error('--output must be outside the repository');
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const parentRel = relative(REPO_ROOT, parent);
  if (parentRel === '' || (!parentRel.startsWith('..') && !isAbsolute(parentRel)))
    throw new Error('--output must be outside the repository');
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error('--output must not be a symlink');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

async function commandVersion(launcher, run = execFile, env = undefined) {
  try {
    const result = await run(launcher.command, invocationArgs(launcher, ['--version']), {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: CODEX_PROBE_TIMEOUT_MS,
      ...(env === undefined ? {} : { env }),
    });
    const value = String(result?.stdout ?? '')
      .split(/\r?\n/, 1)[0]
      .trim();
    return value === '' ? 'unknown' : value.slice(0, 128);
  } catch {
    throw new Error('Codex CLI is unavailable');
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function terminateCodexProcessTree({
  child,
  platform = process.platform,
  force = false,
  run = execFile,
  kill = process.kill,
} = {}) {
  if (!record(child)) return false;
  const pid = child.pid;
  if (platform === 'win32' && Number.isSafeInteger(pid) && pid > 0) {
    try {
      await run('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        windowsHide: true,
        timeout: PROCESS_TERMINATION_COMMAND_TIMEOUT_MS,
      });
      return true;
    } catch {
      // Fall back to the direct child handle below.
    }
  } else if (platform !== 'win32' && Number.isSafeInteger(pid) && pid > 0) {
    try {
      kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      // Fall back to the direct child handle below.
    }
  }
  try {
    return child.kill?.(force ? 'SIGKILL' : 'SIGTERM') === true;
  } catch {
    return false;
  }
}

function runCodexTrial({
  launcher,
  args,
  cwd,
  env,
  timeoutMs,
  platform,
  terminationGraceMs,
  terminate,
  spawn = nodeSpawn,
}) {
  return new Promise((resolveTrial, rejectTrial) => {
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    let timer;
    let resolveClosed;
    const closed = new Promise((resolveClose) => {
      resolveClosed = resolveClose;
    });
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveTrial({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        exitCode,
        signal,
        timedOut,
        spawnError,
        stdoutTruncated,
      });
    };
    let child;
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
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stdoutBytes >= MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      const bounded = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
      stdoutChunks.push(bounded);
      stdoutBytes += bounded.byteLength;
      if (bounded.byteLength < bytes.byteLength) stdoutTruncated = true;
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
    timer = setTimeout(async () => {
      timedOut = true;
      try {
        await terminate({ child, platform, force: false });
      } catch {
        // Continue to the bounded forceful termination path.
      }
      const closedGracefully = await Promise.race([
        closed.then(() => true),
        delay(terminationGraceMs).then(() => false),
      ]);
      if (!closedGracefully) {
        try {
          await terminate({ child, platform, force: true });
        } catch {
          // The close proof below remains authoritative.
        }
        const closedAfterForce = await Promise.race([
          closed.then(() => true),
          delay(terminationGraceMs).then(() => false),
        ]);
        if (!closedAfterForce && !settled) {
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          rejectTrial(new Error('timed-out Codex process tree did not close'));
          return;
        }
      }
      finish(null, null);
    }, timeoutMs);
  });
}

async function oneTrial({
  index,
  launcher,
  args,
  cwd,
  env,
  timeoutMs,
  platform,
  terminationGraceMs,
  terminate,
  spawn,
  target,
}) {
  const started = Date.now();
  const result = await runCodexTrial({
    launcher,
    args,
    cwd,
    env,
    timeoutMs,
    platform,
    terminationGraceMs,
    terminate,
    spawn,
  });
  const parsedResult = parseCodexTrialOutput(result.stdout);
  if (parsedResult.parse_failed) {
    return {
      trial_id: `trial-${String(index + 1).padStart(2, '0')}`,
      classification: 'host_invalid',
      duration_ms: Math.max(0, Date.now() - started),
      usage: {},
      trace: [],
      clarification_detected: false,
      contract_errors: ['parser_failure'],
      parse_failed: true,
    };
  }
  const { parsed } = parsedResult;
  const contractErrors = [...parsed.contract_errors, ...hostDiagnostics(result)];
  const classification = classifySmallModelTrial({
    trace: parsed.trace,
    malformedJsonLines: parsed.malformed_json_lines,
    contractErrors,
    clarificationDetected: parsed.clarification_detected,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    truncated: result.stdoutTruncated,
    target,
  });
  return {
    trial_id: `trial-${String(index + 1).padStart(2, '0')}`,
    classification,
    duration_ms: Math.max(0, Date.now() - started),
    usage: parsed.usage,
    trace: parsed.trace,
    clarification_detected: parsed.clarification_detected,
    contract_errors: contractErrors,
  };
}

export async function runSmallModelEvaluation({
  output,
  trials = DEFAULT_TRIALS,
  threshold = DEFAULT_PASS_THRESHOLD,
  cwd = REPO_ROOT,
  env = process.env,
  spawn = nodeSpawn,
  run = execFile,
  openSession = openMcpBenchmarkSession,
  now = () => new Date().toISOString(),
  timeoutMs = 180_000,
  terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
  platform = process.platform,
  attest = attestBuiltCli,
  terminate = terminateCodexProcessTree,
} = {}) {
  const outputPath = await safeOutputPath(output);
  if (trials !== DEFAULT_TRIALS) {
    throw new Error(`small-model evidence requires exactly ${DEFAULT_TRIALS} trials`);
  }
  if (threshold !== DEFAULT_PASS_THRESHOLD) {
    throw new Error(`small-model evidence requires exactly ${DEFAULT_PASS_THRESHOLD} passes`);
  }
  if (
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    terminationGraceMs > 10_000
  ) {
    throw new Error('terminationGraceMs must be an integer between 1 and 10000');
  }
  if (typeof terminate !== 'function') throw new TypeError('terminate must be a function');
  const target = targetFromEnvironment(env);
  const commitResult = await run('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const commit = String(commitResult.stdout ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('repository commit is unavailable');
  if (typeof attest !== 'function') throw new TypeError('attest must be a function');
  const attestation = await attest({ cwd, expectedCommit: commit });
  let preflight;
  try {
    const cliPath = attestation?.cliPath;
    const builtCli = attestation?.attestation;
    if (!validBuildAttestation(builtCli, commit)) {
      throw new Error('built CLI/core attestation is invalid');
    }
    const childEnv = buildCodexEnvironment(env, target);
    preflight = await openSession({
      cliPath,
      cwd,
      env: {
        DISCORD_TOKEN: target.token,
        ALLOWED_GUILDS: target.guildId,
        DISCORD_DEFAULT_GUILD_ID: target.guildId,
        DISCORD_EXPECTED_BOT_ID: target.botId,
        MCP_DRY_RUN: 'true',
        MCP_WRITE_MODE: 'preview',
        MCP_TOOL_SURFACE: 'progressive',
        MCP_AUDIT_ENABLED: 'false',
      },
      requiredTools: [],
    });
    const available = [...preflight.toolNames].sort();
    const frontDoorAvailable = ENABLED_TOOLS.every((name) => available.includes(name));
    const instructionsAvailable =
      typeof preflight.instructions === 'string' &&
      preflight.instructions.includes('build_discord_server');
    let launcher = null;
    let codexVersion = 'not_run';
    let args = null;
    let hostUnavailable = false;
    if (frontDoorAvailable && instructionsAvailable) {
      try {
        launcher = await resolveCodexLauncher({ platform, run, env });
        codexVersion = await commandVersion(launcher, run, childEnv);
        args = buildCodexArguments({ cliPath, cwd, target });
      } catch {
        hostUnavailable = true;
        codexVersion = 'unavailable';
      }
    }
    const results =
      frontDoorAvailable && instructionsAvailable && !hostUnavailable
        ? await (async () => {
            const ordered = [];
            for (let index = 0; index < trials; index += 1) {
              ordered.push(
                await oneTrial({
                  index,
                  launcher,
                  args,
                  cwd,
                  env: childEnv,
                  timeoutMs,
                  platform,
                  terminationGraceMs,
                  terminate,
                  spawn,
                  target,
                }),
              );
            }
            return ordered;
          })()
        : Array.from({ length: trials }, (_, index) => ({
            trial_id: `trial-${String(index + 1).padStart(2, '0')}`,
            classification: hostUnavailable ? 'host_invalid' : 'product_front_door_missing',
            duration_ms: 0,
            usage: {},
            trace: [],
            clarification_detected: false,
            contract_errors: [],
          }));
    const passes = results.filter((result) => result.classification === 'pass').length;
    const artifact = {
      schema_version: SMALL_MODEL_SCHEMA,
      recorded_at: now(),
      commit,
      built_cli: builtCli,
      model: SMALL_MODEL,
      reasoning_effort: 'low',
      request: SMALL_MODEL_REQUEST,
      target: { guild_id: target.guildId, bot_id: target.botId },
      preview_environment: { ...PREVIEW_ENVIRONMENT },
      execution: {
        policy_conditioned: true,
        mutation_execution: false,
      },
      policy: {
        version: SMALL_MODEL_POLICY_VERSION,
        sha256: sha256(SMALL_MODEL_POLICY),
        text: SMALL_MODEL_POLICY,
      },
      host: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        codex: codexVersion,
      },
      preflight: {
        available_tools: available,
        front_door_available: frontDoorAvailable,
        instructions_available: instructionsAvailable,
      },
      trials: results,
      aggregate: {
        total: trials,
        passes,
        required_passes: threshold,
        meets_threshold: passes >= threshold,
      },
    };
    artifact.integrity = createSmallModelIntegrity({
      artifact,
      integrityKey: target.token,
    });
    assertSecretFreeJson(artifact);
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return artifact;
  } finally {
    try {
      if (preflight !== undefined) await preflight.close();
    } finally {
      if (typeof attestation?.cleanup === 'function') await attestation.cleanup();
    }
  }
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length)
      throw new Error('usage: --output ABSOLUTE_PATH [--trials N] [--threshold N]');
    values[key.slice(2)] = argv[++index];
  }
  if (!values.output) throw new Error('usage: --output ABSOLUTE_PATH [--trials N] [--threshold N]');
  const trials = values.trials === undefined ? DEFAULT_TRIALS : Number(values.trials);
  const threshold =
    values.threshold === undefined ? DEFAULT_PASS_THRESHOLD : Number(values.threshold);
  if (!Number.isInteger(trials) || !Number.isInteger(threshold))
    throw new Error('trials and threshold must be integers');
  return { output: values.output, trials, threshold };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const artifact = await runSmallModelEvaluation(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(artifact.aggregate)}\n`);
    if (!artifact.aggregate.meets_threshold) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'small-model evaluation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
