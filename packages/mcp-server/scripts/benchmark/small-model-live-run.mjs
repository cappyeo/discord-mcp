import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireCampaignLock,
  prepareArtifactStore,
  readBaselineArtifact,
} from './artifact-store.mjs';
import {
  BenchmarkRestoreFailure,
  restoreBenchmarkBaseline,
  verifyBenchmarkBaseline,
} from './baseline-lifecycle.mjs';
import { verifyBlueprintSnapshot } from './blueprint-oracle.mjs';
import { attestBuiltCli } from './build-attestation.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { assertSecretFreeJson, canonicalJson } from './manifest.mjs';
import { createTrialDependencies } from './runtime.mjs';
import {
  createSmallModelIntegrity,
  verifySmallModelIntegrity,
} from './small-model-attestation.mjs';
import { runSmallModelLiveEvaluation, SMALL_MODEL_LIVE_REQUEST } from './small-model-live-eval.mjs';
import { snapshotFingerprint } from './snapshot-fingerprint.mjs';
import {
  activityEvidenceSummary,
  publicationTargets,
  recoverCheckpointBindings,
  validateApply,
  validatePlan,
} from './trial-runner.mjs';

export const SMALL_MODEL_LIVE_RUN_SCHEMA = 'discord-mcp.small-model-live-run.v1';
export const SMALL_MODEL_LIVE_FAILURE_SCHEMA = 'discord-mcp.small-model-live-failure.v1';
export const SMALL_MODEL_LIVE_CONFIRMATION_PREFIX = 'APPROVE_SMALL_MODEL_LIVE:';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_REF = /^dmbpr1\.[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const SAFE_CLASSIFICATION = /^[a-z][a-z0-9_]{0,127}$/;
const RESTORE_RECOVERY_DELAYS_MS = Object.freeze([0, 1_000, 2_000, 4_000, 8_000, 16_000]);
const SAFE_FAILURE_CODES = new Set([
  'LIVE_FAILURE_UNCLASSIFIED',
  'LIVE_PROCESS_QUARANTINED',
  'LIVE_FAILURE_AND_RESTORE_FAILURE',
  'LIVE_FAILURE_ARTIFACT_WRITE_FAILURE',
  'CODEX_AUTH_UNAVAILABLE',
  'CODEX_HOME_INVALID',
  'CODEX_HOME_CLEANUP_MISSING',
  'JSONL_LINE_LIMIT',
  'INITIAL_JSONL_INVALID',
  'INITIAL_PHASE_FAILED',
  'RESUME_JSONL_INVALID',
  'RESUME_HOST_FAILED',
  'RESUME_SESSION_MISMATCH',
  'RESUME_TOOL_CONTRACT_FAILURE',
  'RESUME_INITIAL_BINDING_FAILURE',
  'RESUME_UNSAFE_TOOL_CALL',
  'RESUME_MODEL_NO_APPLY_CALL',
  'RESUME_APPLY_DUPLICATE',
  'RESUME_EVIDENCE_DUPLICATE',
  'RESUME_APPLY_CONTRACT_FAILURE',
  'RESUME_APPLY_CONFIRMATION_FAILURE',
  'RESUME_APPLY_ARGUMENT_TARGET_MISMATCH',
  'RESUME_APPLY_ARGUMENT_APPROVAL_MISMATCH',
  'RESUME_APPLY_ARGUMENT_PLAN_REF_MISMATCH',
  'RESUME_APPLY_TOOL_ERROR',
  'RESUME_APPLY_RESULT_TARGET_MISMATCH',
  'RESUME_APPLY_RESULT_BINDING_MISMATCH',
  'RESUME_APPLY_RESULT_INVALID',
  'RESUME_EVIDENCE_BEFORE_COMPLETION',
  'RESUME_EVIDENCE_BINDING_FAILURE',
  'RESUME_EVIDENCE_VERIFICATION_FAILURE',
  'RESUME_APPLY_TERMINAL_FAILURE',
  'RESUME_RETRY_DELAY_INVALID',
  'RESUME_EXTERNAL_WAIT_LIMIT',
  'RESUME_TURN_LIMIT',
]);
const BASELINE_OUTCOMES = new Set(['not_checked', 'unchanged', 'drifted', 'unavailable']);
const RESTORATION_OUTCOMES = new Set(['not_attempted', 'not_required', 'restored', 'failed']);
const APPLY_RESULT_STATUSES = new Set([
  'complete',
  'already_current',
  'partial',
  'busy',
  'blocked',
  'stale',
]);
const BASELINE_DRIFT_FAILURES = new Set([
  'BASELINE_FINGERPRINT_DRIFT',
  'benchmark guild must have Community enabled',
  'baseline onboarding is not disabled and empty',
  'baseline welcome screen is not disabled and empty',
  'canary channel must have empty message history',
  'canary role is missing or unsafe',
  'canary channel is missing or unsafe',
]);
const MATCH_KEYS = Object.freeze([
  'argument_guild',
  'argument_bot',
  'argument_approval',
  'argument_plan_ref',
  'result_guild',
  'result_bot',
  'result_plan',
  'result_blueprint',
]);
const MAX_FAILURE_DIAGNOSTIC_BYTES = 2_048;

function safeFailureCode(error) {
  const candidate = error?.failureCode ?? error?.code;
  return SAFE_FAILURE_CODES.has(candidate) ? candidate : 'LIVE_FAILURE_UNCLASSIFIED';
}

function safeOptional(value, pattern) {
  return value === null || (typeof value === 'string' && pattern.test(value)) ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeFailureDiagnostic(value) {
  if (!record(value)) return undefined;
  const expected = record(value.expected) ? value.expected : {};
  const observed = record(value.observed) ? value.observed : {};
  const matches = record(value.matches) ? value.matches : {};
  const diagnostic = {
    phase: value.phase === 'resume' ? 'resume' : null,
    turn:
      Number.isSafeInteger(value.turn) && value.turn >= 1 && value.turn <= 64 ? value.turn : null,
    classification:
      typeof value.classification === 'string' && SAFE_CLASSIFICATION.test(value.classification)
        ? value.classification
        : null,
    session_digest: safeOptional(value.session_digest, DIGEST),
    tool: value.tool === 'guild_blueprint_apply' ? value.tool : null,
    call_count: safeCount(value.call_count),
    completed_call_count: safeCount(value.completed_call_count),
    confirmed: typeof value.confirmed === 'boolean' ? value.confirmed : null,
    tool_error: typeof value.tool_error === 'boolean' ? value.tool_error : null,
    expected: {
      guild_id: safeOptional(expected.guild_id, SNOWFLAKE),
      expected_bot_id: safeOptional(expected.expected_bot_id, SNOWFLAKE),
      approval_id: safeOptional(expected.approval_id, DIGEST),
      plan_id: safeOptional(expected.plan_id, DIGEST),
      blueprint_id: safeOptional(expected.blueprint_id, DIGEST),
      plan_ref: safeOptional(expected.plan_ref, PLAN_REF),
    },
    observed: {
      guild_id: safeOptional(observed.guild_id, SNOWFLAKE),
      expected_bot_id: safeOptional(observed.expected_bot_id, SNOWFLAKE),
      approval_id: safeOptional(observed.approval_id, DIGEST),
      plan_ref: safeOptional(observed.plan_ref, PLAN_REF),
      result_guild_id: safeOptional(observed.result_guild_id, SNOWFLAKE),
      result_bot_id: safeOptional(observed.result_bot_id, SNOWFLAKE),
      result_plan_id: safeOptional(observed.result_plan_id, DIGEST),
      result_blueprint_id: safeOptional(observed.result_blueprint_id, DIGEST),
      status: APPLY_RESULT_STATUSES.has(observed.status) ? observed.status : null,
      error_code:
        typeof observed.error_code === 'string' && SAFE_ERROR_CODE.test(observed.error_code)
          ? observed.error_code
          : null,
      completed_total: safeCount(observed.completed_total),
      remaining: safeCount(observed.remaining),
    },
    matches: Object.fromEntries(
      MATCH_KEYS.map((key) => [key, typeof matches[key] === 'boolean' ? matches[key] : null]),
    ),
  };
  const compact = (input) => {
    const output = {};
    for (const [key, child] of Object.entries(input)) {
      if (child === null) continue;
      if (record(child)) {
        const nested = compact(child);
        if (Object.keys(nested).length > 0) output[key] = nested;
      } else {
        output[key] = child;
      }
    }
    return output;
  };
  const result = compact(diagnostic);
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseSmallModelLiveRunArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (
      !['--expected-commit', '--artifact-root', '--run-id', '--guild', '--confirmation'].includes(
        key,
      )
    )
      throw new Error(`unknown argument: ${key}`);
    const value = args[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new Error(`missing value for ${key}`);
    const name = key.slice(2).replaceAll('-', '_');
    if (values[name] !== undefined) throw new Error(`duplicate argument: ${key}`);
    values[name] = value;
  }
  for (const name of ['expected_commit', 'artifact_root', 'run_id', 'guild', 'confirmation'])
    if (values[name] === undefined)
      throw new Error(`missing argument: --${name.replaceAll('_', '-')}`);
  if (!COMMIT.test(values.expected_commit))
    throw new Error('--expected-commit must be a full lowercase Git SHA');
  if (!RUN_ID.test(values.run_id)) throw new Error('--run-id is invalid');
  if (!CONTROLLED_GUILD_IDS.includes(values.guild))
    throw new Error('--guild is outside the controlled pool');
  return values;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
  return value.trim();
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function targetFor(guildId) {
  if (!CONTROLLED_GUILD_IDS.includes(guildId))
    throw new Error('target guild is outside controlled pool');
  return { guildId, botId: CONTROLLED_BOT_ID };
}

function resultData(result) {
  if (!record(result)) return null;
  return result.structured_content ?? result.structuredContent ?? result.data ?? result;
}

function rawCall(calls, phase, tool) {
  return [...calls].reverse().find((call) => call.phase === phase && call.tool === tool);
}

function validateLivePlan(plan, trial) {
  validatePlan(plan, trial);
  if (!PLAN_REF.test(plan.plan_ref ?? '')) throw new Error('LIVE_PLAN_INVALID');
  return plan;
}

function validateLiveApply(result, plan, trial) {
  validateApply(result, plan, trial);
  return result;
}

function planFrom(call, trial) {
  const data = resultData(call?.result);
  if (!record(data)) throw new Error('LIVE_PLAN_MISSING');
  validateLivePlan(data, trial);
  return data;
}

function applyFrom(call, plan, trial) {
  const data = resultData(call?.result);
  const args = call?.arguments ?? {};
  if (!record(data)) throw new Error('LIVE_APPLY_MISSING');
  if (
    args.guild_id !== trial.guild_id ||
    args.expected_bot_id !== trial.expected_bot_id ||
    args.plan_ref !== plan.plan_ref ||
    Object.hasOwn(args, 'plan_token') ||
    args.approval_id !== plan.approval_id ||
    args.__confirm !== true
  )
    throw new Error('LIVE_APPLY_BINDING_MISMATCH');
  validateLiveApply(data, plan, trial);
  if (data.status !== 'complete' || data.progress.remaining !== 0)
    throw new Error('LIVE_APPLY_NOT_COMPLETE');
  return data;
}

function evidenceFrom(call, plan, trial) {
  const data = resultData(call?.result);
  const args = call?.arguments ?? {};
  if (
    !record(data) ||
    args.guild_id !== trial.guild_id ||
    args.expected_bot_id !== trial.expected_bot_id ||
    args.plan_id !== plan.plan_id
  )
    throw new Error('LIVE_EVIDENCE_BINDING_MISMATCH');
  return activityEvidenceSummary(data, plan, trial);
}

function cleanupFromBindings(plan, target, bindings, { requireComplete }) {
  const publicationTargetsForCleanup = publicationTargets(plan.blueprint, bindings, {
    requireComplete,
  });
  return {
    guild_id: target.guildId,
    bot_id: target.botId,
    blueprint_id: plan.blueprint_id,
    plan_id: plan.plan_id,
    bindings,
    publication_targets: publicationTargetsForCleanup,
    message_channel_ids: [
      ...new Set(publicationTargetsForCleanup.map((item) => item.channel_id)),
    ].sort(),
  };
}

async function loadBuiltActivityValidator(builtCli) {
  const corePath = requiredString(builtCli?.corePath, 'builtCli.corePath');
  const expectedDigest = builtCli?.attestation?.core_sha256;
  if (!DIGEST.test(expectedDigest ?? '')) throw new Error('built core attestation is invalid');
  const bytes = await readFile(corePath);
  const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actualDigest !== expectedDigest) throw new Error('built core digest mismatch');
  const module = await import(
    `${pathToFileURL(corePath).href}?small_model_live=${actualDigest.slice(7)}`
  );
  if (typeof module.assertGuildBlueprintActivityEvidence !== 'function')
    throw new Error('built core Activity Evidence validator is missing');
  return module.assertGuildBlueprintActivityEvidence;
}

function safeSummary(plan, apply, evidence, target, before, after, oracle, evaluation, request) {
  return {
    schema_version: SMALL_MODEL_LIVE_RUN_SCHEMA,
    status: 'passed',
    model: 'gpt-5.6-luna',
    request,
    target: { guild_id: target.guildId, bot_id: target.botId },
    plan: {
      plan_id: plan.plan_id,
      blueprint_id: plan.blueprint_id,
      plan_ref: plan.plan_ref,
      operation_count: plan.operations.length,
      source: plan.source,
    },
    apply: { status: apply.status, completed_total: apply.progress.completed_total },
    evidence: {
      status: 'verified',
      evidence_id: evidence.evidence_id ?? null,
      evidence_body: evidence.evidence_body,
      digest_verified: evidence.digest_verified === true,
    },
    baseline: { fingerprint_before: before, fingerprint_after: after },
    oracle: { match: oracle.match, failure_count: oracle.failures?.length ?? null },
    evaluator: {
      status: evaluation?.status ?? null,
      session_digest: evaluation?.session_digest ?? null,
      initial_trace: evaluation?.initial_trace ?? [],
      trace: evaluation?.trace ?? [],
    },
  };
}

function exactBaselineVerification(result, baseline) {
  return (
    result?.verified === true &&
    result.guild_id === baseline.guild_id &&
    result.bot_id === baseline.bot_id &&
    result.fingerprint === baseline.fingerprint
  );
}

function baselineFailureOutcome(error) {
  return error instanceof Error && BASELINE_DRIFT_FAILURES.has(error.message)
    ? 'drifted'
    : 'unavailable';
}

async function restoreWithRecovery({ restore, verifyBaseline, baseline, cleanup, sleep = wait }) {
  let retryProof = null;
  let lastFailure = null;
  for (const delayMs of RESTORE_RECOVERY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);
    let restoreCompleted = false;
    try {
      const result = await restore({
        baseline,
        cleanup,
        reason: 'discord-mcp small-model live restore',
        retryProof,
      });
      if (result?.restored !== true) throw new Error('BASELINE_RESTORE_NOT_CONFIRMED');
      retryProof = result.retryProof ?? retryProof;
      restoreCompleted = true;
      const after = await verifyBaseline();
      if (!exactBaselineVerification(after, baseline))
        throw new Error('BASELINE_RESTORE_VERIFICATION_INVALID');
      return { result, after };
    } catch (error) {
      lastFailure = error;
      if (error instanceof BenchmarkRestoreFailure) {
        if (error.preflightVerified && error.retryProof !== null) retryProof = error.retryProof;
        if (error.readbackMayConfirm) {
          try {
            const after = await verifyBaseline();
            if (exactBaselineVerification(after, baseline)) return { result: null, after };
          } catch {
            // Retry only under the typed restore policy below.
          }
        }
        if (!error.retryable) throw error;
        continue;
      }
      if (restoreCompleted && retryProof !== null) continue;
      throw error;
    }
  }
  throw lastFailure ?? new Error('BASELINE_RESTORE_FAILED');
}

export function createSmallModelLiveArtifact({ summary, expectedCommit, builtCli, restored }) {
  if (!record(summary) || summary.status !== 'passed')
    throw new Error('artifact summary must be passed');
  const artifact = {
    schema_version: SMALL_MODEL_LIVE_RUN_SCHEMA,
    expected_commit: requiredString(expectedCommit, 'expectedCommit'),
    built_cli: builtCli?.attestation ?? builtCli ?? null,
    summary,
    restored: restored === true,
  };
  assertSecretFreeJson(artifact, 'small_model_live_run_artifact');
  return artifact;
}

export function createSmallModelLiveFailureArtifact({
  expectedCommit,
  target,
  failureCode,
  baselineOutcome,
  restorationOutcome,
  lockRetained,
  diagnostic,
} = {}) {
  const targetValue = targetFor(requiredString(target?.guildId, 'target.guildId'));
  if (!COMMIT.test(requiredString(expectedCommit, 'expectedCommit')))
    throw new TypeError('expectedCommit must be a full lowercase Git SHA');
  if (!BASELINE_OUTCOMES.has(baselineOutcome)) throw new TypeError('baselineOutcome is invalid');
  if (!RESTORATION_OUTCOMES.has(restorationOutcome))
    throw new TypeError('restorationOutcome is invalid');
  const artifact = {
    schema_version: SMALL_MODEL_LIVE_FAILURE_SCHEMA,
    status: 'failed',
    model: 'gpt-5.6-luna',
    request: SMALL_MODEL_LIVE_REQUEST,
    expected_commit: expectedCommit,
    target: { guild_id: targetValue.guildId, bot_id: targetValue.botId },
    approved: true,
    failure_code: SAFE_FAILURE_CODES.has(failureCode) ? failureCode : 'LIVE_FAILURE_UNCLASSIFIED',
    baseline: { outcome: baselineOutcome },
    restoration: { outcome: restorationOutcome },
    lock_retained: lockRetained === true,
  };
  const safeDiagnostic = safeFailureDiagnostic(diagnostic);
  if (record(safeDiagnostic)) {
    const serialized = JSON.stringify(safeDiagnostic);
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_FAILURE_DIAGNOSTIC_BYTES)
      artifact.diagnostic = safeDiagnostic;
  }
  assertSecretFreeJson(artifact, 'small_model_live_failure_artifact');
  return artifact;
}

export function verifySmallModelLiveArtifact({
  artifact,
  integrityKey,
  expectedCommit,
  validateActivityEvidence = null,
} = {}) {
  verifySmallModelIntegrity({ artifact, integrityKey });
  if (typeof validateActivityEvidence !== 'function')
    throw new TypeError('attested Activity Evidence validator is required');
  if (
    artifact.schema_version !== SMALL_MODEL_LIVE_RUN_SCHEMA ||
    artifact.expected_commit !== expectedCommit
  )
    throw new Error('small-model live artifact binding mismatch');
  if (artifact.restored !== true || artifact.summary?.status !== 'passed')
    throw new Error('small-model live artifact is not a clean pass');
  const built = artifact.built_cli;
  const summary = artifact.summary;
  const source = summary?.plan?.source;
  const inspirations = Array.isArray(source?.inspirations) ? source.inspirations : [];
  const sourceCandidates = [source?.primary, ...inspirations];
  const sourceValid =
    source?.permission_policy === 'discard_source_and_regenerate' &&
    Array.isArray(source?.inspirations) &&
    inspirations.length <= 3 &&
    sourceCandidates.every(
      (candidate) =>
        record(candidate) &&
        typeof candidate.code === 'string' &&
        candidate.use_url === `https://discord.new/${candidate.code}` &&
        candidate.quality?.verified === true &&
        candidate.quality?.code_match === true &&
        candidate.quality?.permission_handling === 'discarded_and_regenerated' &&
        DIGEST.test(candidate.provenance?.evidence_digest ?? '') &&
        typeof candidate.provenance?.fetched_at === 'string' &&
        !Number.isNaN(Date.parse(candidate.provenance.fetched_at)) &&
        typeof candidate.provenance?.source_guild?.id === 'string',
    );
  const evidenceBody = summary?.evidence?.evidence_body;
  const initialCall = summary?.evaluator?.initial_trace?.[0];
  const applyCall = [...(summary?.evaluator?.trace ?? [])]
    .reverse()
    .find((call) => call?.tool === 'guild_blueprint_apply');
  const evidenceCall = summary?.evaluator?.trace?.find(
    (call) => call?.tool === 'guild_blueprint_evidence',
  );
  if (
    built?.source_commit !== expectedCommit ||
    built?.core_source_commit !== expectedCommit ||
    !DIGEST.test(built?.sha256 ?? '') ||
    !DIGEST.test(built?.core_sha256 ?? '')
  )
    throw new Error('small-model live build attestation is invalid');
  if (
    summary?.model !== 'gpt-5.6-luna' ||
    summary?.request !== SMALL_MODEL_LIVE_REQUEST ||
    !CONTROLLED_GUILD_IDS.includes(summary?.target?.guild_id) ||
    summary?.target?.bot_id !== CONTROLLED_BOT_ID ||
    !DIGEST.test(summary?.plan?.plan_id ?? '') ||
    !DIGEST.test(summary?.plan?.blueprint_id ?? '') ||
    !PLAN_REF.test(summary?.plan?.plan_ref ?? '') ||
    !Number.isSafeInteger(summary?.plan?.operation_count) ||
    summary.plan.operation_count < 1 ||
    sourceValid !== true ||
    summary?.apply?.status !== 'complete' ||
    !Number.isSafeInteger(summary?.apply?.completed_total) ||
    summary.apply.completed_total < 1 ||
    summary.apply.completed_total > summary.plan.operation_count ||
    summary?.evidence?.status !== 'verified' ||
    summary?.evidence?.digest_verified !== true ||
    !DIGEST.test(summary?.evidence?.evidence_id ?? '') ||
    !record(evidenceBody) ||
    !record(evidenceBody.observed) ||
    !Array.isArray(evidenceBody.observed.completed_operation_ids) ||
    evidenceBody.observed.completed_operation_ids.length !== summary.apply.completed_total ||
    evidenceBody.plan_id !== summary.plan.plan_id ||
    evidenceBody.blueprint_id !== summary.plan.blueprint_id ||
    evidenceBody.target?.guild_id !== summary.target.guild_id ||
    evidenceBody.target?.bot_id !== summary.target.bot_id ||
    evidenceBody.initial_operation_count !== summary.plan.operation_count ||
    summary?.baseline?.fingerprint_before !== summary?.baseline?.fingerprint_after ||
    !DIGEST.test(summary?.baseline?.fingerprint_before ?? '') ||
    summary?.oracle?.match !== true ||
    summary?.oracle?.failure_count !== 0 ||
    summary?.evaluator?.status !== 'complete' ||
    !DIGEST.test(summary?.evaluator?.session_digest ?? '') ||
    !Array.isArray(summary?.evaluator?.initial_trace) ||
    summary.evaluator.initial_trace.length !== 1 ||
    initialCall?.tool !== 'build_discord_server' ||
    initialCall?.status !== 'completed' ||
    initialCall?.result_summary?.plan_id !== summary.plan.plan_id ||
    initialCall?.result_summary?.blueprint_id !== summary.plan.blueprint_id ||
    initialCall?.result_summary?.plan_ref !== summary.plan.plan_ref ||
    !Array.isArray(summary?.evaluator?.trace) ||
    applyCall?.status !== 'completed' ||
    applyCall?.confirmed !== true ||
    !applyCall.argument_keys?.includes('plan_ref') ||
    applyCall.argument_keys?.includes('plan_token') ||
    applyCall.argument_projection?.plan_ref !== summary.plan.plan_ref ||
    applyCall?.result_summary?.status !== 'complete' ||
    applyCall?.result_summary?.plan_id !== summary.plan.plan_id ||
    applyCall?.result_summary?.blueprint_id !== summary.plan.blueprint_id ||
    evidenceCall?.status !== 'completed' ||
    evidenceCall?.result_summary?.status !== 'verified' ||
    evidenceCall?.result_summary?.plan_id !== summary.plan.plan_id ||
    evidenceCall?.result_summary?.blueprint_id !== summary.plan.blueprint_id ||
    evidenceCall?.result_summary?.evidence_id !== summary.evidence.evidence_id
  )
    throw new Error('small-model live lifecycle evidence is invalid');
  validateActivityEvidence({
    ...summary.evidence.evidence_body,
    evidence_id: summary.evidence.evidence_id,
  });
  assertSecretFreeJson(artifact, 'small_model_live_run_artifact');
  return artifact;
}

export async function runSmallModelLiveTrial({
  cwd,
  artifactRoot,
  runId,
  expectedCommit,
  guildId,
  confirmation,
  token,
  cliPath,
  request = SMALL_MODEL_LIVE_REQUEST,
  dependencies = {},
} = {}) {
  const target = targetFor(requiredString(guildId, 'guildId'));
  if (!COMMIT.test(requiredString(expectedCommit, 'expectedCommit')))
    throw new Error('expectedCommit must be a full lowercase Git SHA');
  if (!RUN_ID.test(requiredString(runId, 'runId'))) throw new Error('runId is invalid');
  requiredString(token, 'token');
  if (request !== SMALL_MODEL_LIVE_REQUEST) throw new Error('benchmark request is fixed');
  if (confirmation !== `${SMALL_MODEL_LIVE_CONFIRMATION_PREFIX}${target.guildId}`)
    throw new Error('explicit operator confirmation is required');
  const acquireLock = dependencies.acquireLock ?? acquireCampaignLock;
  const lock = await acquireLock({
    botId: CONTROLLED_BOT_ID,
    guildIds: CONTROLLED_GUILD_IDS,
    owner: { run_id: runId, commit: expectedCommit, started_at: new Date().toISOString() },
  });
  let approvalGranted = false;
  let cleanup = null;
  let baseline;
  let restore;
  let builtCli;
  let validateAttestedActivity;
  let plan;
  let retainLock = false;
  let runtime;
  let stateDirectory;
  let store;
  let verifyBaseline;
  const trial = {
    trial_id: runId,
    mode: 'full',
    guild_id: target.guildId,
    expected_bot_id: target.botId,
    profile: 'caller-owned-devbot',
  };
  let restored = false;
  try {
    const readBaseline =
      dependencies.readBaseline ??
      ((input) => readBaselineArtifact({ ...input, integrityKey: token }));
    baseline = await readBaseline({ cwd, artifactRoot, guildId: target.guildId });
    if (baseline.bot_id !== CONTROLLED_BOT_ID) throw new Error('baseline bot mismatch');
    runtime = dependencies.runtime ?? createTrialDependencies({ token });
    restore =
      dependencies.restore ??
      ((input) =>
        restoreBenchmarkBaseline({
          ...input,
          rest: runtime.rest,
          readSnapshot: runtime.readSnapshot,
          snapshotFingerprint,
          allowedGuildIds: CONTROLLED_GUILD_IDS,
          expectedBotId: CONTROLLED_BOT_ID,
          confirmation: `RESET_DISPOSABLE_GUILD:${target.guildId}`,
          integrityKey: token,
        }));
    verifyBaseline =
      dependencies.verifyBaseline ??
      (() =>
        verifyBenchmarkBaseline({
          readSnapshot: runtime.readSnapshot,
          snapshotFingerprint,
          baseline,
          integrityKey: token,
        }));
    const before = (await verifyBaseline()).fingerprint;
    store = dependencies.store ?? (await prepareArtifactStore({ cwd, artifactRoot, runId }));
    builtCli =
      dependencies.builtCli ??
      (await (dependencies.attestBuild ?? attestBuiltCli)({ cwd, expectedCommit }));
    validateAttestedActivity =
      dependencies.validateAttestedActivity ?? (await loadBuiltActivityValidator(builtCli));
    stateDirectory =
      dependencies.stateDirectory ?? (await store.createStateDirectory('small-model-live'));
    const calls = [];
    const evaluate = dependencies.evaluate ?? runSmallModelLiveEvaluation;
    const evaluation = await evaluate({
      cliPath: builtCli.cliPath ?? cliPath,
      cwd,
      target: { ...target, token },
      stateDirectory,
      request,
      env: { ...process.env, DISCORD_TOKEN: token },
      approvalProvenance: {
        source: 'operator_confirmation',
        confirmation,
        guild_id: target.guildId,
      },
      approve: async ({ summary }) => {
        if (
          summary?.target?.guild_id !== target.guildId ||
          summary?.target?.bot_id !== target.botId ||
          summary?.plan_id !== plan?.plan_id ||
          summary?.blueprint_id !== plan?.blueprint_id ||
          summary?.approval_id !== plan?.approval_id ||
          summary?.plan_ref !== plan?.plan_ref
        )
          return false;
        approvalGranted = true;
        return true;
      },
      onValidatedToolCall: (call) => {
        calls.push(call);
        if (call.phase === 'initial' && call.tool === 'build_discord_server') {
          plan = planFrom(call, trial);
        }
        if (
          call.phase === 'resume' &&
          call.tool === 'guild_blueprint_apply' &&
          record(call.result)
        ) {
          const result = resultData(call.result);
          try {
            validateLiveApply(result, plan, trial);
            cleanup = cleanupFromBindings(plan, target, result.evidence.bindings, {
              requireComplete: result.status === 'complete' || result.status === 'already_current',
            });
          } catch {
            cleanup = null;
          }
        }
      },
    });
    const planCall = rawCall(calls, 'initial', 'build_discord_server');
    plan = planFrom(planCall, trial);
    const applyCall = rawCall(calls, 'resume', 'guild_blueprint_apply');
    const apply = applyFrom(applyCall, plan, trial);
    const evidenceCall = rawCall(calls, 'resume', 'guild_blueprint_evidence');
    const evidence = evidenceFrom(evidenceCall, plan, trial);
    validateAttestedActivity({
      ...evidence.evidence_body,
      evidence_id: evidence.evidence_id,
    });
    cleanup = cleanupFromBindings(plan, target, apply.evidence.bindings, {
      requireComplete: true,
    });
    const independent = dependencies.openSession
      ? await dependencies.openSession()
      : await runtime.openSession({
          cliPath: builtCli.cliPath ?? cliPath,
          cwd,
          env: {
            DISCORD_TOKEN: token,
            ALLOWED_GUILDS: target.guildId,
            DISCORD_EXPECTED_BOT_ID: target.botId,
            MCP_DRY_RUN: 'false',
            MCP_WRITE_MODE: 'allow',
            MCP_TOOL_SURFACE: 'full',
            MCP_AUDIT_ENABLED: 'true',
            MCP_BLUEPRINT_STATE_DIR: stateDirectory,
          },
        });
    let independentEvidence;
    try {
      independentEvidence = await independent.callTool('guild_blueprint_evidence', {
        guild_id: target.guildId,
        expected_bot_id: target.botId,
        plan_id: plan.plan_id,
      });
    } finally {
      await independent.close?.();
    }
    const independentEvidenceSummary = evidenceFrom(
      {
        result: independentEvidence,
        arguments: {
          guild_id: target.guildId,
          expected_bot_id: target.botId,
          plan_id: plan.plan_id,
        },
      },
      plan,
      trial,
    );
    validateAttestedActivity({
      ...independentEvidenceSummary.evidence_body,
      evidence_id: independentEvidenceSummary.evidence_id,
    });
    if (
      evidence.evidence_id !== independentEvidenceSummary.evidence_id ||
      canonicalJson(evidence.evidence_body) !==
        canonicalJson(independentEvidenceSummary.evidence_body)
    )
      throw new Error('LIVE_INDEPENDENT_EVIDENCE_MISMATCH');
    const afterSnapshot = await runtime.readSnapshot({
      guildId: target.guildId,
      botId: target.botId,
      messageChannelIds: cleanup.message_channel_ids,
    });
    const oracle = (dependencies.verifySnapshot ?? verifyBlueprintSnapshot)({
      blueprint: plan.blueprint,
      blueprintId: plan.blueprint_id,
      bindings: cleanup.bindings,
      snapshot: afterSnapshot,
      guildId: target.guildId,
      botId: target.botId,
    });
    if (oracle.match !== true) throw new Error('LIVE_ORACLE_MISMATCH');
    const restoration = await restoreWithRecovery({
      restore,
      verifyBaseline,
      baseline,
      cleanup,
      sleep: dependencies.sleep ?? wait,
    });
    restored = true;
    const after = restoration.after.fingerprint;
    const summary = safeSummary(
      plan,
      apply,
      independentEvidenceSummary,
      target,
      before,
      after,
      oracle,
      evaluation,
      request,
    );
    const unsigned = createSmallModelLiveArtifact({
      summary,
      expectedCommit,
      builtCli,
      restored,
    });
    unsigned.integrity = createSmallModelIntegrity({ artifact: unsigned, integrityKey: token });
    await store.writeArtifact('results/small-model-live.json', unsigned);
    return verifySmallModelLiveArtifact({
      artifact: unsigned,
      integrityKey: token,
      expectedCommit,
      validateActivityEvidence: validateAttestedActivity,
    });
  } catch (error) {
    let failureError = error;
    const failureDiagnostic = error?.diagnostic;
    let baselineOutcome = 'not_checked';
    let restorationOutcome = 'not_attempted';
    if (error?.code === 'CODEX_PROCESS_DID_NOT_CLOSE') {
      retainLock = true;
      failureError = new Error('LIVE_PROCESS_QUARANTINED');
      failureError.failureCode = 'LIVE_PROCESS_QUARANTINED';
    } else if (approvalGranted && baseline && !restored) {
      let baselineUnchanged = false;
      try {
        baselineUnchanged = exactBaselineVerification(await verifyBaseline(), baseline);
        baselineOutcome = baselineUnchanged ? 'unchanged' : 'drifted';
      } catch (baselineError) {
        baselineOutcome = baselineFailureOutcome(baselineError);
      }
      if (baselineUnchanged) {
        restorationOutcome = 'not_required';
      } else {
        try {
          if (!cleanup && plan && runtime?.loadCheckpoint) {
            const checkpoint = await runtime.loadCheckpoint({
              stateDirectory,
              planId: plan.plan_id,
            });
            if (checkpoint === null) throw new Error('AUTHENTICATED_CHECKPOINT_MISSING');
            const bindings = recoverCheckpointBindings(checkpoint, plan, trial, null, -1);
            cleanup = cleanupFromBindings(plan, target, bindings, {
              requireComplete: false,
            });
          }
          if (!cleanup) throw new Error('CLEANUP_BINDINGS_UNAVAILABLE');
          await restoreWithRecovery({
            restore,
            verifyBaseline,
            baseline,
            cleanup,
            sleep: dependencies.sleep ?? wait,
          });
          restored = true;
          restorationOutcome = 'restored';
        } catch {
          retainLock = true;
          restorationOutcome = 'failed';
          failureError = new Error('LIVE_FAILURE_AND_RESTORE_FAILURE');
          failureError.failureCode = 'LIVE_FAILURE_AND_RESTORE_FAILURE';
        }
      }
    }
    if (approvalGranted && store) {
      try {
        const failureArtifact = createSmallModelLiveFailureArtifact({
          expectedCommit,
          target,
          failureCode: safeFailureCode(failureError),
          baselineOutcome,
          restorationOutcome,
          lockRetained: retainLock,
          diagnostic: failureDiagnostic,
        });
        await store.writeArtifact('results/small-model-live.failure.json', {
          ...failureArtifact,
          integrity: createSmallModelIntegrity({ artifact: failureArtifact, integrityKey: token }),
        });
      } catch {
        retainLock = true;
        failureError = new Error('LIVE_FAILURE_ARTIFACT_WRITE_FAILURE');
        failureError.failureCode = 'LIVE_FAILURE_ARTIFACT_WRITE_FAILURE';
      }
    }
    throw failureError;
  } finally {
    try {
      if (!retainLock) await lock.release();
    } finally {
      await builtCli?.cleanup?.();
    }
  }
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseSmallModelLiveRunArgs(args);
  const rawToken = environment.DISCORD_TESTBOT_B_TOKEN;
  if (typeof rawToken !== 'string' || rawToken.trim() === '')
    throw new Error('DISCORD_TESTBOT_B_TOKEN is required');
  const token = rawToken.trim().startsWith('Bot ') ? rawToken.trim().slice(4) : rawToken.trim();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
  const result = await runSmallModelLiveTrial({
    cwd: repoRoot,
    artifactRoot: options.artifact_root,
    runId: options.run_id,
    expectedCommit: options.expected_commit,
    guildId: options.guild,
    confirmation: options.confirmation,
    token,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
