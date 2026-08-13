import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { sameFileIdentity } from './file-identity.mjs';
import { assertSecretFreeJson, canonicalJson } from './manifest.mjs';
import {
  SMALL_MODEL_ATTESTATION_SCHEMA,
  verifySmallModelIntegrity,
} from './small-model-attestation.mjs';
import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TRIALS,
  SMALL_MODEL,
  SMALL_MODEL_POLICY,
  SMALL_MODEL_POLICY_VERSION,
  SMALL_MODEL_REQUEST,
} from './small-model-eval.mjs';

export const SMALL_MODEL_VERIFIER_SCHEMA = 'discord-mcp.small-model-verifier.v1';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_GRAPH_FILES = 256;
const MAX_GRAPH_TOTAL_BYTES = 100 * 1024 * 1024;
const GRAPH_PREFIXES = Object.freeze({
  cli: 'packages/mcp-server/dist/',
  core: 'packages/mcp-core/dist/',
});
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PREVIEW_ENVIRONMENT = Object.freeze({
  MCP_DRY_RUN: 'true',
  MCP_WRITE_MODE: 'preview',
  MCP_TOOL_SURFACE: 'progressive',
  MCP_AUDIT_ENABLED: 'false',
});
const ENABLED_TOOLS = new Set(['build_discord_server', 'mcp_tools_search', 'mcp_tools_read']);
// The progressive server advertises its complete bounded catalog during
// preflight.  This is intentionally separate from ENABLED_TOOLS: the latter
// is the model-call allowlist, while preflight also exposes the two
// architecture tools and the write/destructive dispatchers for discovery.
export const PREFLIGHT_TOOLS = new Set([
  'build_discord_server',
  'guild_blueprint_apply',
  'guild_blueprint_evidence',
  'mcp_tools_destructive',
  'mcp_tools_read',
  'mcp_tools_search',
  'mcp_tools_write',
]);
const CLASSIFICATIONS = new Set([
  'pass',
  'model_no_tool_call',
  'tool_contract_failure',
  'unsafe_tool_call',
  'planner_failure',
  'host_invalid',
  'product_front_door_missing',
]);
const USAGE_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (
    !record(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function assertString(value, label, pattern = null) {
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is malformed`);
  }
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is malformed`);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function hashBuiltFile(path, label, maxBytes = MAX_ARTIFACT_BYTES) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maxBytes
  ) {
    throw new Error(`${label} artifact is missing or invalid`);
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened) || opened.size !== metadata.size) {
      throw new Error(`${label} artifact changed while opening`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maxBytes) throw new Error(`${label} artifact is too large`);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const final = await handle.stat();
    if (!sameFileIdentity(metadata, final) || final.size !== total) {
      throw new Error(`${label} artifact changed while reading`);
    }
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

async function assertBuildFileMap(files, prefix, entrypoint, entrypointDigest, repoRoot, label) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_GRAPH_FILES) {
    throw new Error(`${label} graph file map is malformed`);
  }
  const expectedPaths = [];
  const seen = new Set();
  let previous = '';
  let total = 0;
  let entrypointCount = 0;
  for (const file of files) {
    exactKeys(file, ['path', 'sha256'], `${label} graph file`);
    if (
      typeof file.path !== 'string' ||
      !file.path.startsWith(prefix) ||
      file.path.includes('\\') ||
      file.path.includes('/../') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(basename(file.path)) ||
      !validDigest(file.sha256) ||
      seen.has(file.path) ||
      (previous !== '' && file.path <= previous)
    ) {
      throw new Error(`${label} graph file map is malformed`);
    }
    previous = file.path;
    seen.add(file.path);
    expectedPaths.push(file.path);
    if (file.path === entrypoint) {
      entrypointCount += 1;
      if (file.sha256 !== entrypointDigest) {
        throw new Error(`${label} entrypoint digest is not bound to its graph`);
      }
    }
  }
  if (entrypointCount !== 1) throw new Error(`${label} entrypoint is missing from its graph`);
  const directory = resolve(repoRoot, prefix.slice(0, -1));
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`${label} graph directory is missing or invalid`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const actualPaths = entries
    .filter((entry) => entry.name.endsWith('.js'))
    .map((entry) => `${prefix}${entry.name}`)
    .sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    canonicalJson(actualPaths) !== canonicalJson(expectedPaths)
  ) {
    throw new Error(`${label} graph has missing or extra JavaScript files`);
  }
  for (const entry of entries) {
    if (entry.name.endsWith('.js') && (entry.isSymbolicLink() || !entry.isFile())) {
      throw new Error(`${label} graph contains an invalid JavaScript entry`);
    }
  }
  for (const file of files) {
    const path = resolve(repoRoot, file.path);
    const relativePath = relative(repoRoot, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`${label} graph path escaped the repository`);
    }
    const metadata = await lstat(path);
    total += metadata.size;
    if (total > MAX_GRAPH_TOTAL_BYTES) throw new Error(`${label} graph is too large`);
    const actual = await hashBuiltFile(path, `${label} ${basename(file.path)}`);
    if (actual !== file.sha256) throw new Error(`${label} ${basename(file.path)} digest mismatch`);
  }
  return true;
}

async function assertBuildAttestation(value, commit, repoRoot) {
  exactKeys(
    value,
    [
      'entrypoint',
      'sha256',
      'source_commit',
      'core_entrypoint',
      'core_sha256',
      'core_source_commit',
      'files',
      'core_files',
    ],
    'built_cli',
  );
  if (
    value.entrypoint !== 'packages/mcp-server/dist/cli.js' ||
    value.core_entrypoint !== 'packages/mcp-core/dist/index.js' ||
    value.source_commit !== commit ||
    value.core_source_commit !== commit
  ) {
    throw new Error('built CLI/core attestation commit or entrypoint mismatch');
  }
  assertString(value.sha256, 'built_cli.sha256', DIGEST);
  assertString(value.core_sha256, 'built_cli.core_sha256', DIGEST);
  for (const [entrypoint, expected, label] of [
    [value.entrypoint, value.sha256, 'built CLI'],
    [value.core_entrypoint, value.core_sha256, 'built core'],
  ]) {
    const path = resolve(repoRoot, entrypoint);
    const relativePath = relative(repoRoot, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`${label} entrypoint escaped the repository`);
    }
    const actual = await hashBuiltFile(path, label);
    if (actual !== expected) throw new Error(`${label} digest does not match the attestation`);
  }
  await assertBuildFileMap(
    value.files,
    GRAPH_PREFIXES.cli,
    value.entrypoint,
    value.sha256,
    repoRoot,
    'built CLI',
  );
  await assertBuildFileMap(
    value.core_files,
    GRAPH_PREFIXES.core,
    value.core_entrypoint,
    value.core_sha256,
    repoRoot,
    'built core',
  );
}

// Synchronous filesystem helpers keep the semantic verifier deterministic after
// the bounded artifact read. They are intentionally local and never follow a
// missing path into an alternate location.

function assertTimestamp(value, label) {
  assertString(value, label, ISO_TIMESTAMP);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} is malformed`);
}

function assertPolicy(value) {
  exactKeys(value, ['version', 'sha256', 'text'], 'policy');
  if (value.version !== SMALL_MODEL_POLICY_VERSION || value.text !== SMALL_MODEL_POLICY) {
    throw new Error('small-model policy does not match the verified policy');
  }
  if (value.sha256 !== digest(value.text)) throw new Error('small-model policy digest mismatch');
}

function assertTarget(value) {
  exactKeys(value, ['guild_id', 'bot_id'], 'target');
  assertString(value.guild_id, 'target.guild_id', SNOWFLAKE);
  assertString(value.bot_id, 'target.bot_id', SNOWFLAKE);
  if (!CONTROLLED_GUILD_IDS.includes(value.guild_id) || value.bot_id !== CONTROLLED_BOT_ID) {
    throw new Error('small-model target is outside the controlled guild/bot scope');
  }
}

function assertPreviewEnvironment(value) {
  exactKeys(value, Object.keys(PREVIEW_ENVIRONMENT), 'preview_environment');
  if (canonicalJson(value) !== canonicalJson(PREVIEW_ENVIRONMENT)) {
    throw new Error('small-model preview environment contract mismatch');
  }
}

function assertUsage(value, label) {
  if (!record(value)) throw new Error(`${label} is malformed`);
  for (const [key, count] of Object.entries(value)) {
    if (!USAGE_KEYS.has(key)) throw new Error(`${label}.${key} is not allowed`);
    assertNonnegativeInteger(count, `${label}.${key}`);
  }
}

function validDigest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}

function assertPassTrace(trace, target, request) {
  if (!Array.isArray(trace) || trace.length < 1) throw new Error('passing trial has no tool trace');
  const requestDigest = digest(request);
  const complete = trace.filter((call) => call.status === 'completed');
  if (complete.length === 1 && trace.length === 1 && complete[0].tool === 'build_discord_server') {
    if (
      canonicalJson(complete[0].argument_keys) !== canonicalJson(['request']) ||
      complete[0].request_digest !== requestDigest
    ) {
      throw new Error('passing direct call does not bind the exact request');
    }
    assertPlanSummary(complete[0].result_summary, target);
    return;
  }
  if (
    complete.length !== 2 ||
    trace.length !== 2 ||
    complete[0].tool !== 'mcp_tools_search' ||
    complete[1].tool !== 'mcp_tools_read' ||
    !complete[0].argument_keys.includes('query') ||
    !complete[0].argument_keys.every((key) => key === 'query' || key === 'limit') ||
    canonicalJson(complete[1].argument_keys) !== canonicalJson(['args', 'tool']) ||
    canonicalJson(complete[1].nested_argument_keys) !== canonicalJson(['request']) ||
    complete[1].target_tool !== 'build_discord_server' ||
    complete[0].request_digest !== requestDigest ||
    complete[1].request_digest !== requestDigest
  ) {
    throw new Error('passing fallback trace violates the tool contract');
  }
  assertPlanSummary(complete[1].result_summary, target);
}

function assertPlanSummary(summary, target) {
  if (!record(summary) || !['ready', 'already_current'].includes(summary.status)) {
    throw new Error('passing trace is missing a valid architecture result');
  }
  if (!record(summary.target) || canonicalJson(summary.target) !== canonicalJson(target)) {
    throw new Error('passing trace target mismatch');
  }
  exactKeys(
    summary,
    ['status', 'target', 'counts', 'safety', 'template_evidence'],
    'result_summary',
  );
  exactKeys(
    summary.counts,
    [
      'roles',
      'categories',
      'channels',
      'onboarding_prompts',
      'automod_rules',
      'publications',
      'operations',
    ],
    'result_summary.counts',
  );
  for (const key of [
    'roles',
    'categories',
    'channels',
    'onboarding_prompts',
    'automod_rules',
    'publications',
  ]) {
    if (!Number.isSafeInteger(summary.counts[key]) || summary.counts[key] < 1) {
      throw new Error(`result_summary.counts.${key} is invalid`);
    }
  }
  assertNonnegativeInteger(summary.counts.operations, 'result_summary.counts.operations');
  if ((summary.status === 'ready') !== summary.counts.operations > 0) {
    throw new Error('result summary status/operation relation is invalid');
  }
  if (summary.status === 'already_current' && summary.counts.operations !== 0) {
    throw new Error('already_current result must have zero operations');
  }
  exactKeys(
    summary.safety,
    [
      'blueprint_validation',
      'target_readback',
      'source_permissions_discarded',
      'source_overwrites_discarded',
      'severe_generated_role_permissions',
      'dangling_symbolic_references',
      'onboarding_requirements_met',
      'components_v2_pre_resolution_valid',
    ],
    'result_summary.safety',
  );
  if (
    summary.safety.blueprint_validation !== 'passed' ||
    summary.safety.target_readback !== 'passed' ||
    summary.safety.source_permissions_discarded !== true ||
    summary.safety.source_overwrites_discarded !== true ||
    summary.safety.severe_generated_role_permissions !== 0 ||
    summary.safety.dangling_symbolic_references !== 0 ||
    summary.safety.onboarding_requirements_met !== true ||
    summary.safety.components_v2_pre_resolution_valid !== true
  ) {
    throw new Error('passing result contains unsafe plan evidence');
  }
  if (
    !record(summary.template_evidence) ||
    !record(summary.template_evidence.primary) ||
    !Array.isArray(summary.template_evidence.inspirations) ||
    summary.template_evidence.inspirations.length > 3
  ) {
    throw new Error('passing result is missing template evidence');
  }
}

function assertTrial(value, index, target, request) {
  if (!record(value)) throw new Error(`trial-${index + 1} is malformed`);
  const expectedId = `trial-${String(index + 1).padStart(2, '0')}`;
  const keys = value.parse_failed
    ? [
        'trial_id',
        'classification',
        'duration_ms',
        'usage',
        'trace',
        'clarification_detected',
        'contract_errors',
        'parse_failed',
      ]
    : [
        'trial_id',
        'classification',
        'duration_ms',
        'usage',
        'trace',
        'clarification_detected',
        'contract_errors',
      ];
  exactKeys(value, keys, expectedId);
  if (value.trial_id !== expectedId || !CLASSIFICATIONS.has(value.classification))
    throw new Error(`${expectedId} identity/classification is invalid`);
  assertNonnegativeInteger(value.duration_ms, `${expectedId}.duration_ms`);
  assertUsage(value.usage, `${expectedId}.usage`);
  if (
    !Array.isArray(value.trace) ||
    !Array.isArray(value.contract_errors) ||
    typeof value.clarification_detected !== 'boolean'
  )
    throw new Error(`${expectedId} trace metadata is malformed`);
  if (
    !value.contract_errors.every((error) => typeof error === 'string' && /^[a-z0-9_]+$/.test(error))
  )
    throw new Error(`${expectedId}.contract_errors is malformed`);
  for (const call of value.trace) {
    if (!record(call)) throw new Error(`${expectedId} contains an invalid sanitized tool trace`);
    const callKeys = [
      'tool',
      'argument_keys',
      ...(call.contract_invalid === undefined ? [] : ['contract_invalid']),
      ...(call.nested_argument_keys === undefined ? [] : ['nested_argument_keys']),
      'request_digest',
      ...(call.target_tool === undefined ? [] : ['target_tool']),
      ...(call.result_summary === undefined ? [] : ['result_summary']),
      'status',
    ];
    exactKeys(call, callKeys, `${expectedId}.trace`);
    if (
      !ENABLED_TOOLS.has(call.tool) ||
      !Array.isArray(call.argument_keys) ||
      (!validDigest(call.request_digest) && call.request_digest !== null) ||
      !['started', 'completed'].includes(call.status)
    ) {
      throw new Error(`${expectedId} contains an invalid sanitized tool trace`);
    }
    if (call.nested_argument_keys !== undefined && !Array.isArray(call.nested_argument_keys))
      throw new Error(`${expectedId}.trace nested keys are malformed`);
    if (call.target_tool !== undefined && typeof call.target_tool !== 'string')
      throw new Error(`${expectedId}.trace target tool is malformed`);
    if (call.contract_invalid !== undefined && call.contract_invalid !== true)
      throw new Error(`${expectedId}.trace contract flag is malformed`);
  }
  if (value.classification === 'pass') {
    if (
      value.parse_failed === true ||
      value.contract_errors.length > 0 ||
      value.clarification_detected
    )
      throw new Error(`${expectedId} pass is not fail-closed`);
    assertPassTrace(value.trace, target, request);
  }
}

async function assertNoSymlinkPath(path, label) {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} contains a symlink`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readArtifact(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('artifact path must be absolute');
  await assertNoSymlinkPath(path, 'small-model artifact');
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > MAX_ARTIFACT_BYTES
  )
    throw new Error('small-model artifact is missing or outside the size bound');

  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('small-model artifact is missing or outside the size bound');
    }
    throw error;
  }
  let text;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      !sameFileIdentity(metadata, opened) ||
      opened.size !== metadata.size
    ) {
      throw new Error('small-model artifact changed while opening');
    }

    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    const final = await handle.stat();
    if (final.size > MAX_ARTIFACT_BYTES || bytesRead > MAX_ARTIFACT_BYTES) {
      throw new Error('small-model artifact is missing or outside the size bound');
    }
    if (!sameFileIdentity(metadata, final) || final.size !== bytesRead) {
      throw new Error('small-model artifact changed while reading');
    }
    text = bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch {
    throw new Error('small-model artifact is not valid JSON');
  }
  assertSecretFreeJson(artifact, 'small-model artifact');
  return { artifact, raw: text };
}

export async function verifySmallModelArtifact({
  artifactPath,
  expectedCommit,
  integrityKey,
  repoRoot = REPO_ROOT,
} = {}) {
  assertString(artifactPath, 'artifactPath');
  assertString(expectedCommit, 'expectedCommit', COMMIT);
  assertString(integrityKey, 'DISCORD_TOKEN');
  if (integrityKey.length < 50) throw new Error('DISCORD_TOKEN is malformed');
  const { artifact, raw } = await readArtifact(artifactPath);
  if (raw.includes(integrityKey))
    throw new Error('small-model artifact contains the caller secret');
  exactKeys(
    artifact,
    [
      'schema_version',
      'recorded_at',
      'commit',
      'built_cli',
      'model',
      'reasoning_effort',
      'request',
      'target',
      'preview_environment',
      'execution',
      'policy',
      'host',
      'preflight',
      'trials',
      'aggregate',
      'integrity',
    ],
    'small-model artifact',
  );
  if (
    artifact.schema_version !== 'discord-mcp.small-model-eval.v2' ||
    artifact.commit !== expectedCommit
  )
    throw new Error('small-model artifact schema or commit mismatch');
  assertTimestamp(artifact.recorded_at, 'recorded_at');
  if (
    artifact.model !== SMALL_MODEL ||
    artifact.reasoning_effort !== 'low' ||
    artifact.request !== SMALL_MODEL_REQUEST
  )
    throw new Error('small-model identity or request mismatch');
  assertTarget(artifact.target);
  assertPreviewEnvironment(artifact.preview_environment);
  exactKeys(artifact.execution, ['policy_conditioned', 'mutation_execution'], 'execution');
  if (
    artifact.execution.policy_conditioned !== true ||
    artifact.execution.mutation_execution !== false
  )
    throw new Error('small-model execution contract is not policy-conditioned preview');
  assertPolicy(artifact.policy);
  exactKeys(artifact.host, ['node', 'platform', 'arch', 'codex'], 'host');
  for (const key of ['node', 'platform', 'arch', 'codex'])
    assertString(artifact.host[key], `host.${key}`);
  exactKeys(
    artifact.preflight,
    ['available_tools', 'front_door_available', 'instructions_available'],
    'preflight',
  );
  const availableTools = artifact.preflight.available_tools;
  if (
    !Array.isArray(availableTools) ||
    availableTools.length !== new Set(availableTools).size ||
    canonicalJson(availableTools) !== canonicalJson([...availableTools].sort()) ||
    !availableTools.every((tool) => typeof tool === 'string' && PREFLIGHT_TOOLS.has(tool)) ||
    ![...ENABLED_TOOLS].every((tool) => availableTools.includes(tool))
  )
    throw new Error('preflight tools are malformed');
  if (
    typeof artifact.preflight.front_door_available !== 'boolean' ||
    typeof artifact.preflight.instructions_available !== 'boolean'
  )
    throw new Error('preflight contract is malformed');
  verifySmallModelIntegrity({ artifact, integrityKey });
  await assertBuildAttestation(artifact.built_cli, expectedCommit, resolve(repoRoot));
  if (!Array.isArray(artifact.trials) || artifact.trials.length !== DEFAULT_TRIALS)
    throw new Error(`small-model evidence requires exactly ${DEFAULT_TRIALS} trials`);
  for (const [index, trial] of artifact.trials.entries()) {
    assertTrial(trial, index, artifact.target, artifact.request);
  }
  exactKeys(
    artifact.aggregate,
    ['total', 'passes', 'required_passes', 'meets_threshold'],
    'aggregate',
  );
  if (artifact.aggregate.total !== artifact.trials.length)
    throw new Error('aggregate total does not match trials');
  const passes = artifact.trials.filter((trial) => trial.classification === 'pass').length;
  if (
    artifact.aggregate.passes !== passes ||
    artifact.aggregate.required_passes !== DEFAULT_PASS_THRESHOLD ||
    artifact.aggregate.meets_threshold !== passes >= artifact.aggregate.required_passes
  )
    throw new Error('small-model aggregate is inconsistent');
  return {
    verifier_schema: SMALL_MODEL_VERIFIER_SCHEMA,
    artifact_schema: artifact.schema_version,
    attestation_schema: SMALL_MODEL_ATTESTATION_SCHEMA,
    commit: artifact.commit,
    target: artifact.target,
    trials: artifact.aggregate.total,
    passes,
    required_passes: artifact.aggregate.required_passes,
    meets_threshold: artifact.aggregate.meets_threshold,
    policy_conditioned: true,
    mutation_execution: false,
    hmac_verified: true,
    build_attestation_verified: true,
  };
}

export function parseSmallModelVerifierArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const allowed = new Set(['--artifact', '--expected-commit']);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || Object.hasOwn(values, key) || index + 1 >= argv.length)
      throw new Error('usage: --artifact ABSOLUTE_PATH --expected-commit FULL_COMMIT');
    const value = argv[++index];
    if (typeof value !== 'string' || value.startsWith('--'))
      throw new Error('usage: --artifact ABSOLUTE_PATH --expected-commit FULL_COMMIT');
    values[key] = value;
  }
  if (!values['--artifact'] || !values['--expected-commit'])
    throw new Error('usage: --artifact ABSOLUTE_PATH --expected-commit FULL_COMMIT');
  return {
    artifactPath: values['--artifact'],
    expectedCommit: values['--expected-commit'],
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifySmallModelArtifact({
      ...parseSmallModelVerifierArgs(process.argv.slice(2)),
      integrityKey: process.env.DISCORD_TOKEN,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.meets_threshold) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'small-model verification failed'}\n`,
    );
    process.exitCode = 1;
  }
}
