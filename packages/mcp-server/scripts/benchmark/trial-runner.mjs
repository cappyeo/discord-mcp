import { createHash } from 'node:crypto';

const SUCCESS_STATUSES = new Set(['complete', 'already_current']);
const NEXT_ACTIONS = new Set(['done', 'resume', 'replan', 'fix_configuration']);
const SNOWFLAKE = /^\d{17,20}$/;
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
const SETTLE_DELAYS_MS = Object.freeze([0, 250, 500, 1_000, 2_000, 4_000]);
const PLAN_RECOVERY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const APPLY_RECOVERY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000]);
const MAIN_APPLY_OPERATION_BUDGET = 10;
const MAX_EXTERNAL_RECOVERY_WAIT_MS = 15 * 60_000;
const MESSAGE_HISTORY_CHANNEL_TYPES = new Set([0, 5]);
const BINDING_KINDS = Object.freeze([
  'roles',
  'categories',
  'channels',
  'automod_rules',
  'publications',
]);
const REQUIRED_DEPENDENCIES = [
  'openSession',
  'readSnapshot',
  'snapshotFingerprint',
  'readAuditCursor',
  'readAuditTrail',
  'buildExpectations',
  'compareSnapshots',
  'verifyBlueprintSnapshot',
  'verifyAuditTrail',
  'loadCheckpoint',
];
const PROGRESSIVE_SEARCH_TOOL = 'mcp_tools_search';
const PROGRESSIVE_READ_TOOL = 'mcp_tools_read';
const PROGRESSIVE_DESTRUCTIVE_TOOL = 'mcp_tools_destructive';

class TrialFailure extends Error {
  constructor(code, { serious = false, terminalStatus = 'error' } = {}) {
    super(code);
    this.name = 'TrialFailure';
    this.code = code;
    this.serious = serious;
    this.terminalStatus = terminalStatus;
  }
}

function fail(code, options) {
  throw new TrialFailure(code, options);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function baselineMessageChannels(snapshot, requiredChannelId) {
  const ids = new Set([requiredChannelId]);
  for (const channel of Array.isArray(snapshot?.channels) ? snapshot.channels : []) {
    if (
      MESSAGE_HISTORY_CHANNEL_TYPES.has(Number(channel?.type)) &&
      SNOWFLAKE.test(channel?.id ?? '')
    ) {
      ids.add(channel.id);
    }
  }
  return [...ids].sort();
}

async function settleBeforeAttempt(dependencies, attempt) {
  const milliseconds = SETTLE_DELAYS_MS[attempt];
  if (milliseconds > 0) await (dependencies.sleep ?? wait)(milliseconds);
}

function assertRecord(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function assertTarget(value, trial, code) {
  assertRecord(value, code);
  if (value.guild_id !== trial.guild_id || value.bot_id !== trial.expected_bot_id) fail(code);
}

function digest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function activityEvidenceBody(plan, activity) {
  return {
    schema_version: activity.schema_version,
    recorded_at: activity.recorded_at,
    plan_id: plan.plan_id,
    blueprint_id: plan.blueprint_id,
    target: plan.target,
    blueprint: plan.blueprint,
    initial_operation_count: activity.initial_operation_count ?? plan.operations.length,
    plan_invariants: activity.plan_invariants,
    observed: activity.observed,
  };
}

export function activityEvidenceDigest(plan, activity) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(activityEvidenceBody(plan, activity)))
    .digest('hex')}`;
}

function validTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function templateCandidateEvidence(candidate, catalogVersion) {
  assertRecord(candidate, 'TEMPLATE_EVIDENCE_INVALID');
  const code = candidate.code;
  if (
    typeof code !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(code) ||
    candidate.use_url !== `https://discord.new/${code}` ||
    candidate.quality?.verified !== true ||
    candidate.quality?.code_match !== true ||
    candidate.quality?.permission_handling !== 'discarded_and_regenerated' ||
    !digest(candidate.provenance?.evidence_digest) ||
    !validTimestamp(candidate.provenance?.fetched_at)
  ) {
    fail('TEMPLATE_EVIDENCE_INVALID');
  }
  if (
    !Array.isArray(candidate.contributes) ||
    !Array.isArray(candidate.structural_contributions) ||
    new Set(candidate.contributes).size !== candidate.contributes.length ||
    new Set(candidate.structural_contributions).size !==
      candidate.structural_contributions.length ||
    candidate.contributes.some((value) => !RECOMMENDATION_CAPABILITIES.has(value)) ||
    candidate.structural_contributions.some((value) => !STRUCTURAL_DIMENSIONS.has(value))
  ) {
    fail('TEMPLATE_EVIDENCE_INVALID');
  }
  const sourceGuild = candidate.provenance.source_guild;
  if (
    !assertRecord(sourceGuild, 'TEMPLATE_EVIDENCE_INVALID') ||
    typeof sourceGuild.id !== 'string' ||
    !SNOWFLAKE.test(sourceGuild.id) ||
    (sourceGuild.snapshot_id !== null && typeof sourceGuild.snapshot_id !== 'string') ||
    (sourceGuild.icon_hash !== null && typeof sourceGuild.icon_hash !== 'string') ||
    (sourceGuild.preferred_locale !== null && typeof sourceGuild.preferred_locale !== 'string')
  ) {
    fail('TEMPLATE_EVIDENCE_INVALID');
  }
  return {
    code,
    catalog_version: catalogVersion,
    fetched_at: candidate.provenance.fetched_at,
    use_url: candidate.use_url,
    verified: true,
    code_match: true,
    permission_handling: 'discarded_and_regenerated',
    contributes: [...candidate.contributes],
    structural_contributions: [...candidate.structural_contributions],
    evidence_digest: candidate.provenance.evidence_digest,
    source_guild: {
      id: sourceGuild.id,
      snapshot_id: sourceGuild.snapshot_id,
      icon_hash: sourceGuild.icon_hash,
      preferred_locale: sourceGuild.preferred_locale,
    },
  };
}

function validateTemplateSource(source) {
  assertRecord(source, 'TEMPLATE_EVIDENCE_INVALID');
  if (
    typeof source.catalog_version !== 'string' ||
    source.catalog_version.trim() === '' ||
    source.permission_policy !== 'discard_source_and_regenerate'
  )
    fail('TEMPLATE_EVIDENCE_INVALID');
  const primary = templateCandidateEvidence(source.primary, source.catalog_version);
  if (!Array.isArray(source.inspirations) || source.inspirations.length > 3)
    fail('TEMPLATE_EVIDENCE_INVALID');
  const inspirations = source.inspirations.map((candidate) =>
    templateCandidateEvidence(candidate, source.catalog_version),
  );
  if (
    [primary, ...inspirations].some(
      (candidate) =>
        candidate.contributes.length === 0 && candidate.structural_contributions.length === 0,
    )
  ) {
    fail('TEMPLATE_EVIDENCE_INVALID');
  }
  const codes = [primary.code, ...inspirations.map((candidate) => candidate.code)];
  if (new Set(codes).size !== codes.length) fail('TEMPLATE_EVIDENCE_INVALID');
  return { primary, inspirations };
}

function expectedActivityCounts(blueprint) {
  assertRecord(blueprint, 'ACTIVITY_EVIDENCE_INVALID');
  const prompts = Array.isArray(blueprint.onboarding?.prompts)
    ? blueprint.onboarding.prompts
    : null;
  if (
    !Array.isArray(blueprint.roles) ||
    !Array.isArray(blueprint.categories) ||
    !Array.isArray(blueprint.channels) ||
    !Array.isArray(blueprint.automod?.rules) ||
    !Array.isArray(blueprint.components_v2?.publications) ||
    prompts === null
  ) {
    fail('ACTIVITY_EVIDENCE_INVALID');
  }
  return {
    identity: 2,
    roles: blueprint.roles.length,
    categories: blueprint.categories.length,
    channels: blueprint.channels.length,
    ordering: 2,
    guild: 1,
    welcome_screen: 1,
    onboarding:
      1 + prompts.length + prompts.reduce((total, prompt) => total + prompt.options.length, 0),
    automod: blueprint.automod.rules.length,
    components_v2: blueprint.components_v2.publications.length,
  };
}

function blueprintCounts(blueprint) {
  assertRecord(blueprint, 'ACTIVITY_EVIDENCE_INVALID');
  const prompts = Array.isArray(blueprint.onboarding?.prompts)
    ? blueprint.onboarding.prompts
    : null;
  if (
    !Array.isArray(blueprint.roles) ||
    !Array.isArray(blueprint.categories) ||
    !Array.isArray(blueprint.channels) ||
    !Array.isArray(blueprint.automod?.rules) ||
    !Array.isArray(blueprint.components_v2?.publications) ||
    prompts === null
  ) {
    fail('ACTIVITY_EVIDENCE_INVALID');
  }
  return {
    roles: blueprint.roles.length,
    categories: blueprint.categories.length,
    channels: blueprint.channels.length,
    automod_rules: blueprint.automod.rules.length,
    publications: blueprint.components_v2.publications.length,
    onboarding_prompts: prompts.length,
    onboarding_options: prompts.reduce((total, prompt) => total + prompt.options.length, 0),
  };
}

function validateActivityRecord(activity, plan, code, { requireEvidenceId = true } = {}) {
  assertRecord(activity, code);
  if (
    activity.schema_version !== 'guild_blueprint_activity_evidence.v1' ||
    (requireEvidenceId && !digest(activity.evidence_id)) ||
    !validTimestamp(activity.recorded_at) ||
    (activity.initial_operation_count !== undefined &&
      (!Number.isInteger(activity.initial_operation_count) ||
        activity.initial_operation_count !== plan.operations.length)) ||
    !assertRecord(activity.plan_invariants, code) ||
    !assertRecord(activity.observed, code)
  ) {
    fail(code);
  }
  const expectedCounts = expectedActivityCounts(plan.blueprint);
  if (JSON.stringify(activity.plan_invariants.expected_counts) !== JSON.stringify(expectedCounts))
    fail(code);
  const safetyPolicy = activity.plan_invariants.safety_policy;
  if (
    !assertRecord(safetyPolicy, code) ||
    safetyPolicy.source_permissions_applied !== false ||
    safetyPolicy.dangerous_generated_permissions !== 0 ||
    safetyPolicy.bot_permission_grants !== 0 ||
    safetyPolicy.discord_managed_role_mutations !== 0
  ) {
    fail(code);
  }
  const observed = activity.observed;
  if (
    !digest(observed.initial_snapshot_id) ||
    observed.initial_snapshot_id !== plan.snapshot_id ||
    !digest(observed.final_snapshot_id) ||
    !Number.isInteger(observed.checkpoint_version) ||
    observed.checkpoint_version < 0 ||
    !Array.isArray(observed.completed_operation_ids) ||
    new Set(observed.completed_operation_ids).size !== observed.completed_operation_ids.length ||
    observed.completed_operation_ids.some(
      (operationId) => !plan.operations.some((operation) => operation.operation_id === operationId),
    ) ||
    observed.blueprint_readback_match !== true
  ) {
    fail(code);
  }
  validateBlueprintBindings(observed.bindings, blueprintBindingDomains(plan), {
    code,
    serious: true,
  });
  validatePublicationBindingLinks(observed.bindings, plan, { code, serious: true });
  if (requireEvidenceId && activity.evidence_id !== activityEvidenceDigest(plan, activity)) {
    fail(code);
  }
  return activity;
}

function activityEvidenceSummary(result, plan, trial) {
  assertRecord(result, 'ACTIVITY_EVIDENCE_INVALID');
  if (
    result.status !== 'verified' ||
    result.plan_id !== plan.plan_id ||
    result.blueprint_id !== plan.blueprint_id ||
    result.target?.guild_id !== trial.guild_id ||
    result.target?.bot_id !== trial.expected_bot_id ||
    !digest(result.evidence_id) ||
    !assertRecord(result.record, 'ACTIVITY_EVIDENCE_INVALID') ||
    !assertRecord(result.verification, 'ACTIVITY_EVIDENCE_INVALID')
  ) {
    fail('ACTIVITY_EVIDENCE_INVALID');
  }
  validateActivityRecord(result.record, plan, 'ACTIVITY_EVIDENCE_INVALID', {
    requireEvidenceId: false,
  });
  if (result.evidence_id !== activityEvidenceDigest(plan, result.record)) {
    fail('ACTIVITY_EVIDENCE_INVALID');
  }
  const verification = result.verification;
  if (
    verification.identity_verified !== true ||
    verification.guild_verified !== true ||
    verification.readback !== 'match' ||
    typeof verification.snapshot_unchanged !== 'boolean' ||
    !assertRecord(verification.current_snapshot, 'ACTIVITY_EVIDENCE_INVALID') ||
    !digest(verification.current_snapshot.snapshot_id) ||
    verification.current_snapshot.guild?.id !== trial.guild_id ||
    verification.current_snapshot.bot_id !== trial.expected_bot_id ||
    !Array.isArray(verification.remaining_operations) ||
    verification.remaining_operations.length !== 0 ||
    !Array.isArray(verification.blockers) ||
    verification.blockers.length !== 0 ||
    (verification.snapshot_unchanged === true &&
      verification.current_snapshot.snapshot_id !== result.record.observed.final_snapshot_id)
  ) {
    fail('ACTIVITY_EVIDENCE_INVALID');
  }
  return {
    schema_version: result.record.schema_version,
    evidence_id: result.evidence_id,
    recorded_at: result.record.recorded_at,
    digest_verified: true,
    plan_id: result.plan_id,
    blueprint_id: result.blueprint_id,
    target: { guild_id: trial.guild_id, bot_id: trial.expected_bot_id },
    initial_snapshot_id: result.record.observed.initial_snapshot_id,
    final_snapshot_id: result.record.observed.final_snapshot_id,
    current_snapshot_id: result.verification.current_snapshot.snapshot_id,
    initial_operation_count: result.record.initial_operation_count ?? plan.operations.length,
    checkpoint_version: result.record.observed.checkpoint_version,
    completed_operation_count: result.record.observed.completed_operation_ids.length,
    blueprint_readback_match: true,
    identity_verified: true,
    guild_verified: true,
    readback: 'match',
    snapshot_unchanged: verification.snapshot_unchanged,
    evidence_body: {
      schema_version: result.record.schema_version,
      recorded_at: result.record.recorded_at,
      plan_id: result.plan_id,
      blueprint_id: plan.blueprint_id,
      target: plan.target,
      blueprint: plan.blueprint,
      initial_operation_count: result.record.initial_operation_count ?? plan.operations.length,
      plan_invariants: result.record.plan_invariants,
      observed: result.record.observed,
    },
    expected_counts: result.record.plan_invariants.expected_counts,
    blueprint_counts: blueprintCounts(plan.blueprint),
    safety_policy: result.record.plan_invariants.safety_policy,
  };
}

function validateInput(input) {
  assertRecord(input, 'TRIAL_INPUT_INVALID');
  const trial = assertRecord(input.trial, 'TRIAL_INPUT_INVALID');
  if (!['full', 'forced_resume'].includes(trial.mode)) fail('TRIAL_MODE_INVALID');
  for (const key of ['trial_id', 'guild_id', 'expected_bot_id', 'profile']) {
    if (typeof trial[key] !== 'string' || trial[key].trim() === '') fail('TRIAL_INPUT_INVALID');
  }
  if (
    typeof input.request !== 'string' ||
    input.request.trim().length < 3 ||
    input.request.length > 500
  ) {
    fail('TRIAL_REQUEST_INVALID');
  }
  for (const key of ['cliPath', 'cwd', 'token', 'stateDirectory']) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') fail('TRIAL_INPUT_INVALID');
  }
  if (!SNOWFLAKE.test(input.baselineMessageChannelId ?? '')) fail('TRIAL_INPUT_INVALID');
  const dependencies = assertRecord(input.dependencies, 'TRIAL_DEPENDENCIES_INVALID');
  for (const key of REQUIRED_DEPENDENCIES) {
    if (typeof dependencies[key] !== 'function') fail('TRIAL_DEPENDENCIES_INVALID');
  }
  if (dependencies.sleep !== undefined && typeof dependencies.sleep !== 'function') {
    fail('TRIAL_DEPENDENCIES_INVALID');
  }
  if (
    dependencies.injectApplyResultLoss !== undefined &&
    typeof dependencies.injectApplyResultLoss !== 'function'
  ) {
    fail('TRIAL_DEPENDENCIES_INVALID');
  }
}

function childEnv(input) {
  return {
    ALLOWED_GUILDS: input.trial.guild_id,
    DISCORD_EXPECTED_BOT_ID: input.trial.expected_bot_id,
    DISCORD_TOKEN: input.token,
    MCP_AUDIT_ENABLED: 'true',
    MCP_BLUEPRINT_STATE_DIR: input.stateDirectory,
    MCP_DRY_RUN: 'false',
    MCP_TOOL_SURFACE: 'progressive',
    MCP_WRITE_MODE: 'allow',
  };
}

function validateProgressiveContract(result, toolName, dispatcher, requiredFields) {
  assertRecord(result, 'PROGRESSIVE_DISCOVERY_INVALID');
  if (!Array.isArray(result.matches) || result.matches.length !== 1) {
    fail('PROGRESSIVE_DISCOVERY_INVALID');
  }
  const match = result.matches[0];
  assertRecord(match, 'PROGRESSIVE_DISCOVERY_INVALID');
  const properties = match.inputSchema?.properties;
  const required = match.inputSchema?.required;
  const expectedReadOnly = dispatcher === PROGRESSIVE_READ_TOOL;
  if (
    match.name !== toolName ||
    match.dispatcher !== dispatcher ||
    typeof match.description !== 'string' ||
    match.description === '' ||
    match.inputSchema === null ||
    typeof match.inputSchema !== 'object' ||
    Array.isArray(match.inputSchema) ||
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    !Array.isArray(required) ||
    JSON.stringify([...required].sort()) !== JSON.stringify([...requiredFields].sort()) ||
    requiredFields.some((field) => !Object.hasOwn(properties, field)) ||
    match.annotations === null ||
    typeof match.annotations !== 'object' ||
    Array.isArray(match.annotations) ||
    match.annotations.readOnlyHint !== expectedReadOnly ||
    match.annotations.destructiveHint !== !expectedReadOnly
  ) {
    fail('PROGRESSIVE_DISCOVERY_INVALID');
  }
  return match;
}

async function discoverProgressiveTool(session, query, toolName, dispatcher, requiredFields) {
  const result = await session.callTool(PROGRESSIVE_SEARCH_TOOL, { query, limit: 1 });
  return validateProgressiveContract(result, toolName, dispatcher, requiredFields);
}

async function dispatchProgressiveTool(session, contract, args) {
  return session.callTool(contract.dispatcher, { tool: contract.name, args });
}

function validatePlan(plan, trial) {
  // The 20-trial campaign deliberately keeps the self-contained token path as
  // backward-compatibility coverage. The separate approved small-model live
  // lifecycle is the release gate for caller-local plan_ref execution.
  assertRecord(plan, 'PLAN_RESPONSE_INVALID');
  if (plan.status !== 'ready') {
    fail('PLAN_NOT_READY', {
      terminalStatus: ['blocked', 'no_match'].includes(plan.status) ? 'blocked' : 'error',
    });
  }
  assertTarget(plan.target, trial, 'PLAN_TARGET_MISMATCH');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(plan.blueprint_id ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(plan.snapshot_id ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(plan.plan_id ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(plan.approval_id ?? '') ||
    typeof plan.plan_token !== 'string' ||
    plan.plan_token === '' ||
    plan.blueprint === null ||
    typeof plan.blueprint !== 'object' ||
    !Array.isArray(plan.operations) ||
    plan.operations.length === 0
  ) {
    fail('PLAN_RESPONSE_INVALID');
  }
  validateTemplateSource(plan.source);
  const operationIds = new Set();
  for (const operation of plan.operations) {
    if (
      operation === null ||
      typeof operation !== 'object' ||
      typeof operation.operation_id !== 'string' ||
      operation.operation_id === '' ||
      operationIds.has(operation.operation_id)
    ) {
      fail('PLAN_RESPONSE_INVALID');
    }
    operationIds.add(operation.operation_id);
  }
  if (!Array.isArray(plan.blockers) || plan.blockers.length !== 0) fail('PLAN_RESPONSE_INVALID');
  return plan;
}

function validateApply(result, plan, trial) {
  assertRecord(result, 'APPLY_RESPONSE_INVALID');
  assertTarget(result.target, trial, 'APPLY_TARGET_MISMATCH');
  if (result.plan_id !== plan.plan_id || result.blueprint_id !== plan.blueprint_id) {
    fail('APPLY_PLAN_MISMATCH');
  }
  if (![...SUCCESS_STATUSES, 'partial', 'blocked', 'busy', 'stale'].includes(result.status)) {
    fail('APPLY_RESPONSE_INVALID');
  }
  assertRecord(result.progress, 'APPLY_RESPONSE_INVALID');
  assertRecord(result.evidence, 'APPLY_RESPONSE_INVALID');
  assertRecord(result.evidence.bindings, 'APPLY_RESPONSE_INVALID');
  const progress = result.progress;
  for (const field of [
    'initial_planned',
    'planned_this_call',
    'attempted_this_call',
    'completed_total',
    'remaining',
  ]) {
    if (!Number.isInteger(progress[field]) || progress[field] < 0) fail('APPLY_RESPONSE_INVALID');
  }
  if (
    progress.planned_this_call > 50 ||
    progress.attempted_this_call > progress.planned_this_call ||
    (progress.checkpoint_version !== null &&
      (!Number.isInteger(progress.checkpoint_version) || progress.checkpoint_version < 0))
  ) {
    fail('APPLY_RESPONSE_INVALID');
  }
  if (!Array.isArray(result.attempts) || result.attempts.length !== progress.attempted_this_call) {
    fail('APPLY_RESPONSE_INVALID');
  }
  const plannedOperationIds = new Set(plan.operations.map((operation) => operation.operation_id));
  const attemptedOperationIds = new Set();
  for (const attempt of result.attempts) {
    if (
      attempt === null ||
      typeof attempt !== 'object' ||
      !plannedOperationIds.has(attempt.operation_id) ||
      attemptedOperationIds.has(attempt.operation_id) ||
      !['completed', 'failed'].includes(attempt.status) ||
      (attempt.resource_id !== null && typeof attempt.resource_id !== 'string') ||
      (attempt.error_code !== null && typeof attempt.error_code !== 'string') ||
      (attempt.status === 'completed' && attempt.error_code !== null) ||
      (attempt.status === 'failed' && typeof attempt.error_code !== 'string')
    ) {
      fail('APPLY_RESPONSE_INVALID');
    }
    attemptedOperationIds.add(attempt.operation_id);
  }
  if (
    !Array.isArray(result.blockers) ||
    !NEXT_ACTIONS.has(result.next_action) ||
    typeof result.evidence.identity_verified !== 'boolean' ||
    typeof result.evidence.guild_verified !== 'boolean' ||
    !['match', 'drift', 'not_run'].includes(result.evidence.readback) ||
    !Array.isArray(result.evidence.completed_operation_ids)
  ) {
    fail('APPLY_RESPONSE_INVALID');
  }
  for (const blocker of result.blockers) {
    if (
      blocker === null ||
      typeof blocker !== 'object' ||
      typeof blocker.code !== 'string' ||
      blocker.code === '' ||
      typeof blocker.message !== 'string' ||
      (blocker.resource !== null && typeof blocker.resource !== 'string') ||
      typeof blocker.recovery_hint !== 'string'
    ) {
      fail('APPLY_RESPONSE_INVALID');
    }
  }
  if (result.error !== null) {
    const error = result.error;
    if (
      typeof error !== 'object' ||
      Array.isArray(error) ||
      (error.operation_id !== null && typeof error.operation_id !== 'string') ||
      typeof error.code !== 'string' ||
      error.code === '' ||
      typeof error.retriable !== 'boolean' ||
      (error.status !== null &&
        (!Number.isInteger(error.status) || error.status < 100 || error.status > 599)) ||
      (error.retry_after_ms !== undefined &&
        (!Number.isSafeInteger(error.retry_after_ms) || error.retry_after_ms < 0))
    ) {
      fail('APPLY_RESPONSE_INVALID');
    }
  }
  const bindingKinds = Object.keys(result.evidence.bindings).sort();
  if (
    JSON.stringify(bindingKinds) !==
    JSON.stringify(['automod_rules', 'categories', 'channels', 'publications', 'roles'])
  ) {
    fail('APPLY_RESPONSE_INVALID');
  }
  for (const value of Object.values(result.evidence.bindings)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      fail('APPLY_RESPONSE_INVALID');
  }
  const bindingFailure = { code: 'APPLY_BINDINGS_INVALID', serious: true };
  const bindingDomains = blueprintBindingDomains(plan, bindingFailure);
  validateBlueprintBindings(result.evidence.bindings, bindingDomains, bindingFailure);
  validatePublicationBindingLinks(result.evidence.bindings, plan, bindingFailure);
  validateCompletedOperationIds(result.evidence.completed_operation_ids, plan, {
    code: 'APPLY_RESPONSE_INVALID',
    serious: false,
  });
  if (
    (result.status === 'complete' || result.status === 'already_current') &&
    (progress.remaining !== 0 ||
      result.next_action !== 'done' ||
      result.error !== null ||
      result.blockers.length !== 0)
  ) {
    fail('APPLY_RESPONSE_INVALID');
  }
  return result;
}

function applyArgs(input, plan, operationBudget) {
  return {
    guild_id: input.trial.guild_id,
    expected_bot_id: input.trial.expected_bot_id,
    plan_token: plan.plan_token,
    approval_id: plan.approval_id,
    operation_budget: operationBudget,
    __confirm: true,
  };
}

function publicationTargets(blueprint, bindings, { requireComplete = true } = {}) {
  const publications = blueprint?.components_v2?.publications;
  if (!Array.isArray(publications)) fail('PUBLICATION_BINDING_INVALID');
  if (typeof requireComplete !== 'boolean') fail('PUBLICATION_BINDING_INVALID');
  if (
    bindings === null ||
    typeof bindings !== 'object' ||
    Array.isArray(bindings) ||
    bindings.channels === null ||
    typeof bindings.channels !== 'object' ||
    Array.isArray(bindings.channels) ||
    bindings.publications === null ||
    typeof bindings.publications !== 'object' ||
    Array.isArray(bindings.publications)
  ) {
    fail('PUBLICATION_BINDING_INVALID');
  }
  const keys = new Set();
  const pairs = new Set();
  const definitions = new Map();
  for (const publication of publications) {
    if (
      publication === null ||
      typeof publication !== 'object' ||
      typeof publication.key !== 'string' ||
      publication.key === '' ||
      typeof publication.channel_key !== 'string' ||
      publication.channel_key === '' ||
      keys.has(publication.key)
    ) {
      fail('PUBLICATION_BINDING_INVALID');
    }
    keys.add(publication.key);
    definitions.set(publication.key, publication);
  }
  const boundKeys = Object.keys(bindings.publications).sort();
  if (boundKeys.some((key) => !keys.has(key))) fail('PUBLICATION_BINDING_INVALID');
  if (requireComplete && JSON.stringify(boundKeys) !== JSON.stringify([...keys].sort())) {
    fail('PUBLICATION_BINDING_INVALID');
  }
  const targets = boundKeys.map((key) => {
    const publication = definitions.get(key);
    const channelId = bindings.channels[publication.channel_key];
    const messageId = bindings.publications[key];
    if (
      typeof channelId !== 'string' ||
      !SNOWFLAKE.test(channelId) ||
      typeof messageId !== 'string' ||
      !SNOWFLAKE.test(messageId)
    ) {
      fail('PUBLICATION_BINDING_INVALID');
    }
    const pair = `${channelId}:${messageId}`;
    if (pairs.has(pair)) fail('PUBLICATION_BINDING_INVALID');
    pairs.add(pair);
    return { channel_id: channelId, message_id: messageId };
  });
  return targets.sort((left, right) => {
    const leftKey = `${left.channel_id}:${left.message_id}`;
    const rightKey = `${right.channel_id}:${right.message_id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function safeFailure(error) {
  if (error instanceof TrialFailure) return error;
  if (error?.code === 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET') {
    return new TrialFailure('RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET');
  }
  return new TrialFailure('TRIAL_EXECUTION_FAILED');
}

function retryableSessionError(error) {
  if (error instanceof TrialFailure) return false;
  if (error?.source === 'mcp_tool_result') return error.retriable === true;
  return true;
}

function recoveryDelay(error, fallback) {
  const retryAfter = error?.retry_after_ms ?? error?.retryAfterMs;
  if (!Number.isSafeInteger(retryAfter) || retryAfter < 0) return fallback;
  if (retryAfter > MAX_EXTERNAL_RECOVERY_WAIT_MS) {
    fail('RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET');
  }
  return Math.max(fallback, retryAfter);
}

function rejectValidation({ code, serious }) {
  fail(code, { serious });
}

function blueprintBindingDomains(
  plan,
  failure = { code: 'CHECKPOINT_RECOVERY_REJECTED', serious: true },
) {
  const blueprint = plan.blueprint;
  const collections = {
    roles: blueprint.roles,
    categories: blueprint.categories,
    channels: blueprint.channels,
    automod_rules: blueprint.automod?.rules,
    publications: blueprint.components_v2?.publications,
  };
  const domains = {};
  for (const kind of BINDING_KINDS) {
    const resources = collections[kind];
    if (!Array.isArray(resources)) rejectValidation(failure);
    const keys = resources.map((resource) => resource?.key);
    if (
      keys.some((key) => typeof key !== 'string' || key === '') ||
      new Set(keys).size !== keys.length
    ) {
      rejectValidation(failure);
    }
    domains[kind] = new Set(keys);
  }
  return domains;
}

function validateBlueprintBindings(
  bindings,
  domains,
  failure = { code: 'CHECKPOINT_RECOVERY_REJECTED', serious: true },
) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    rejectValidation(failure);
  }
  if (JSON.stringify(Object.keys(bindings).sort()) !== JSON.stringify([...BINDING_KINDS].sort())) {
    rejectValidation(failure);
  }
  const ids = new Set();
  for (const kind of BINDING_KINDS) {
    const values = bindings[kind];
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      rejectValidation(failure);
    }
    for (const [key, id] of Object.entries(values)) {
      if (!domains[kind].has(key) || typeof id !== 'string' || !SNOWFLAKE.test(id) || ids.has(id)) {
        rejectValidation(failure);
      }
      ids.add(id);
    }
  }
}

function validatePublicationBindingLinks(
  bindings,
  plan,
  failure = { code: 'CHECKPOINT_RECOVERY_REJECTED', serious: true },
) {
  for (const publication of plan.blueprint.components_v2.publications) {
    if (
      bindings.publications[publication.key] !== undefined &&
      bindings.channels[publication.channel_key] === undefined
    ) {
      rejectValidation(failure);
    }
  }
}

function validateCompletedOperationIds(
  operationIds,
  plan,
  failure = { code: 'CHECKPOINT_RECOVERY_REJECTED', serious: true },
) {
  if (!Array.isArray(operationIds)) rejectValidation(failure);
  const plannedOperationIds = new Set(plan.operations.map((operation) => operation.operation_id));
  const completedOperationIds = new Set();
  for (const operationId of operationIds) {
    if (
      typeof operationId !== 'string' ||
      !plannedOperationIds.has(operationId) ||
      completedOperationIds.has(operationId)
    ) {
      rejectValidation(failure);
    }
    completedOperationIds.add(operationId);
  }
}

function mergeCheckpointBindings(current, recovered, domains) {
  validateBlueprintBindings(recovered, domains);
  if (current === null) return structuredClone(recovered);
  validateBlueprintBindings(current, domains);
  const merged = {};
  for (const kind of BINDING_KINDS) {
    merged[kind] = { ...current[kind] };
    for (const [key, id] of Object.entries(recovered[kind])) {
      if (merged[kind][key] !== undefined && merged[kind][key] !== id) {
        fail('CHECKPOINT_RECOVERY_REJECTED', { serious: true });
      }
      merged[kind][key] = id;
    }
  }
  validateBlueprintBindings(merged, domains);
  return merged;
}

function recoverCheckpointBindings(checkpoint, plan, trial, current, latestCheckpointVersion) {
  const record = assertRecord(checkpoint, 'CHECKPOINT_RECOVERY_REJECTED');
  if (
    record.schema_version !== 'guild_blueprint_checkpoint.v1' ||
    record.plan_id !== plan.plan_id ||
    record.blueprint_id !== plan.blueprint_id ||
    !Number.isSafeInteger(record.version) ||
    record.version < 0 ||
    record.version < latestCheckpointVersion ||
    !['applying', 'partial', 'complete'].includes(record.status)
  ) {
    fail('CHECKPOINT_RECOVERY_REJECTED', { serious: true });
  }
  assertTarget(record.target, trial, 'CHECKPOINT_RECOVERY_REJECTED');
  validateCompletedOperationIds(record.completed_operation_ids, plan);
  const domains = blueprintBindingDomains(plan);
  const merged = mergeCheckpointBindings(current, record.bindings, domains);
  validatePublicationBindingLinks(merged, plan);
  return merged;
}

function nonterminalApplySummary(result) {
  return {
    status: result.status,
    error_operation_id: result.error?.operation_id ?? null,
    error_code: result.error?.code ?? null,
    error_retriable: result.error?.retriable ?? null,
    error_status: result.error?.status ?? null,
    ...(result.error?.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: result.error.retry_after_ms }),
    next_action: result.next_action,
    blocker_codes: result.blockers.map((blocker) => blocker.code),
    blocker_resources: result.blockers.map((blocker) => blocker.resource),
  };
}

function applyResponseNeedsRecovery(result) {
  if (result.next_action !== 'resume' || result.blockers.length > 0) return false;
  if (result.status === 'busy') return result.error === null || result.error.retriable === true;
  return ['partial', 'blocked'].includes(result.status) && result.error?.retriable === true;
}

function emptyCleanup(input) {
  return {
    guild_id: input.trial.guild_id,
    bot_id: input.trial.expected_bot_id,
    blueprint_id: null,
    plan_id: null,
    bindings: null,
    message_channel_ids: [],
    publication_targets: [],
  };
}

export {
  activityEvidenceSummary,
  publicationTargets,
  recoverCheckpointBindings,
  validateApply,
  validatePlan,
};

export async function runBenchmarkTrial(input) {
  validateInput(input);
  const { dependencies, trial } = input;
  const cleanup = emptyCleanup(input);
  const serious = [];
  const functional = [];
  let currentSession = null;
  let sessionOpenCount = 0;
  let sessionTerminationUncertain = false;
  let externalRecoveryWaitMs = 0;
  let applyCalls = 0;
  let latestCheckpointVersion = -1;
  let lastApplyResultUnavailable = false;
  let applyResultLossObserved = false;
  let applyResultLossRecovered = false;
  let planRecoveryCount = 0;
  let planSnapshotUnchanged = false;
  let progressiveDiscoverySucceeded = false;
  let dryRunObservedBeforeApply = false;
  let forcedResumeObserved = false;
  let replayStatus = null;
  let evidenceStatus = null;
  let operationsPlanned = 0;
  let auditEntryCount = 0;
  let auditTrailComplete = false;
  let verifiedCounts = null;
  let snapshotOraclePass = false;
  let blueprintOracleMatch = false;
  let auditOraclePass = false;
  let terminalStatus = 'error';
  let lastNonterminalApply = null;
  let templateEvidence = null;
  let activityEvidence = null;
  let plan;
  let before;
  let baselineMessageChannelIds = [input.baselineMessageChannelId];
  const sleep = dependencies.sleep ?? wait;

  const closeCurrent = async () => {
    const session = currentSession;
    currentSession = null;
    if (session !== null) {
      try {
        await session.close();
      } catch {
        sessionTerminationUncertain = true;
        throw new TrialFailure('SESSION_CLOSE_FAILED');
      }
    }
  };
  const open = async () => {
    currentSession = await dependencies.openSession({
      cliPath: input.cliPath,
      cwd: input.cwd,
      env: childEnv(input),
    });
    sessionOpenCount += 1;
    return currentSession;
  };
  const reopen = async (milliseconds) => {
    await closeCurrent();
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      externalRecoveryWaitMs + milliseconds > MAX_EXTERNAL_RECOVERY_WAIT_MS
    ) {
      fail('RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET');
    }
    externalRecoveryWaitMs += milliseconds;
    await sleep(milliseconds);
    await open();
  };
  const createApplyRecovery = () => {
    let recoveryCount = 0;
    let highestCompletedTotal = 0;
    return {
      observe(result) {
        if (result.progress.completed_total > highestCompletedTotal) {
          highestCompletedTotal = result.progress.completed_total;
          recoveryCount = 0;
        }
      },
      async recover(error) {
        if (recoveryCount >= APPLY_RECOVERY_DELAYS_MS.length) return false;
        const milliseconds = recoveryDelay(error, APPLY_RECOVERY_DELAYS_MS[recoveryCount]);
        recoveryCount += 1;
        await reopen(milliseconds);
        return true;
      },
    };
  };
  const callPlan = async () => {
    while (true) {
      let rawPlan;
      try {
        const contract = await discoverProgressiveTool(
          currentSession,
          input.request,
          'guild_blueprint_plan',
          PROGRESSIVE_READ_TOOL,
          ['request'],
        );
        rawPlan = await dispatchProgressiveTool(currentSession, contract, {
          request: input.request,
        });
      } catch (error) {
        if (!retryableSessionError(error) || planRecoveryCount >= PLAN_RECOVERY_DELAYS_MS.length) {
          throw error;
        }
        const milliseconds = recoveryDelay(error, PLAN_RECOVERY_DELAYS_MS[planRecoveryCount]);
        planRecoveryCount += 1;
        await reopen(milliseconds);
        continue;
      }
      const validated = validatePlan(rawPlan, trial);
      templateEvidence = validateTemplateSource(validated.source);
      progressiveDiscoverySucceeded = true;
      return validated;
    }
  };
  const callApply = async (operationBudget, recoverApply) => {
    while (true) {
      let rawApply;
      applyCalls += 1;
      try {
        const contract = await discoverProgressiveTool(
          currentSession,
          'guild_blueprint_apply',
          'guild_blueprint_apply',
          PROGRESSIVE_DESTRUCTIVE_TOOL,
          ['approval_id', 'expected_bot_id', 'guild_id', 'plan_token'],
        );
        rawApply = await dispatchProgressiveTool(
          currentSession,
          contract,
          applyArgs(input, plan, operationBudget),
        );
        if (typeof dependencies.injectApplyResultLoss === 'function') {
          const injection = await dependencies.injectApplyResultLoss({
            rawApply,
            applyCall: applyCalls,
            operationBudget,
            trial,
          });
          if (injection?.observed === true) applyResultLossObserved = true;
        }
      } catch (error) {
        if (error?.code === 'RESULT_LOST_AFTER_MUTATION') applyResultLossObserved = true;
        lastApplyResultUnavailable = true;
        if (!retryableSessionError(error) || !(await recoverApply.recover(error))) throw error;
        continue;
      }
      lastApplyResultUnavailable = false;
      const result = validateApply(rawApply, plan, trial);
      if (applyResultLossObserved) applyResultLossRecovered = true;
      recoverApply.observe(result);
      return result;
    }
  };
  const rememberApply = (result) => {
    cleanup.bindings = structuredClone(result.evidence.bindings);
    if (result.progress.checkpoint_version !== null) {
      latestCheckpointVersion = Math.max(
        latestCheckpointVersion,
        result.progress.checkpoint_version,
      );
    }
    if (!SUCCESS_STATUSES.has(result.status)) {
      lastNonterminalApply = nonterminalApplySummary(result);
    }
  };

  try {
    const auditCursor = await dependencies.readAuditCursor({
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
    });
    const discoverySnapshot = await dependencies.readSnapshot({
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
      messageChannelIds: baselineMessageChannelIds,
    });
    baselineMessageChannelIds = baselineMessageChannels(
      discoverySnapshot,
      input.baselineMessageChannelId,
    );
    before =
      baselineMessageChannelIds.length === 1
        ? discoverySnapshot
        : await dependencies.readSnapshot({
            guildId: trial.guild_id,
            botId: trial.expected_bot_id,
            messageChannelIds: baselineMessageChannelIds,
          });
    const beforeFingerprint = dependencies.snapshotFingerprint(before);

    await open();
    plan = await callPlan();
    operationsPlanned = plan.operations.length;
    cleanup.blueprint_id = plan.blueprint_id;
    cleanup.plan_id = plan.plan_id;

    const afterPlan = await dependencies.readSnapshot({
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
      messageChannelIds: baselineMessageChannelIds,
    });
    planSnapshotUnchanged = dependencies.snapshotFingerprint(afterPlan) === beforeFingerprint;
    if (!planSnapshotUnchanged) {
      fail('PLAN_MUTATED_DISCORD', { serious: true });
    }
    dryRunObservedBeforeApply = true;

    let latestApply;
    const mainApplyRecovery = createApplyRecovery();
    if (trial.mode === 'forced_resume') {
      const forcedObservationRecovery = createApplyRecovery();
      while (true) {
        latestApply = await callApply(1, forcedObservationRecovery);
        rememberApply(latestApply);
        if (
          latestApply.status === 'partial' &&
          latestApply.error === null &&
          latestApply.progress.attempted_this_call === 1 &&
          latestApply.attempts[0]?.status === 'completed' &&
          latestApply.progress.remaining >= 1
        ) {
          break;
        }
        if (
          !applyResponseNeedsRecovery(latestApply) ||
          !(await forcedObservationRecovery.recover(latestApply.error))
        ) {
          fail('FORCED_RESUME_NOT_OBSERVED', { terminalStatus: latestApply.status });
        }
      }
      forcedResumeObserved = true;
      await closeCurrent();
      await open();
    }

    const plannedSlices = Math.max(1, Math.ceil(operationsPlanned / MAIN_APPLY_OPERATION_BUDGET));
    const mainApplyIterationLimit = plannedSlices * (APPLY_RECOVERY_DELAYS_MS.length + 1) + 1;
    let highestMainCompletedTotal = latestApply?.progress.completed_total ?? 0;
    let consecutiveMainNoProgress = 0;
    for (let iteration = 0; iteration < mainApplyIterationLimit; iteration += 1) {
      latestApply = await callApply(MAIN_APPLY_OPERATION_BUDGET, mainApplyRecovery);
      rememberApply(latestApply);
      if (latestApply.progress.completed_total > highestMainCompletedTotal) {
        highestMainCompletedTotal = latestApply.progress.completed_total;
        consecutiveMainNoProgress = 0;
      } else {
        consecutiveMainNoProgress += 1;
      }
      if (SUCCESS_STATUSES.has(latestApply.status)) break;
      if (
        latestApply.status === 'partial' &&
        latestApply.error === null &&
        latestApply.next_action === 'resume' &&
        latestApply.blockers.length === 0
      ) {
        if (consecutiveMainNoProgress >= APPLY_RECOVERY_DELAYS_MS.length) break;
        continue;
      }
      if (
        applyResponseNeedsRecovery(latestApply) &&
        (await mainApplyRecovery.recover(latestApply.error))
      ) {
        continue;
      }
      break;
    }
    if (latestApply === undefined) fail('APPLY_RESPONSE_INVALID');
    terminalStatus = SUCCESS_STATUSES.has(latestApply.status) ? 'complete' : latestApply.status;
    if (!SUCCESS_STATUSES.has(latestApply.status)) {
      fail('APPLY_DID_NOT_COMPLETE', { terminalStatus: latestApply.status });
    }
    if (
      latestApply.evidence.identity_verified !== true ||
      latestApply.evidence.guild_verified !== true ||
      latestApply.evidence.readback !== 'match' ||
      latestApply.evidence.activity === null
    ) {
      fail('APPLY_EVIDENCE_INVALID');
    }
    validateActivityRecord(latestApply.evidence.activity, plan, 'APPLY_EVIDENCE_INVALID');

    const replayRecovery = createApplyRecovery();
    let replay = await callApply(MAIN_APPLY_OPERATION_BUDGET, replayRecovery);
    rememberApply(replay);
    while (applyResponseNeedsRecovery(replay) && (await replayRecovery.recover(replay.error))) {
      replay = await callApply(MAIN_APPLY_OPERATION_BUDGET, replayRecovery);
      rememberApply(replay);
    }
    replayStatus = replay.status;
    if (
      replay.status !== 'already_current' ||
      replay.progress.attempted_this_call !== 0 ||
      replay.progress.remaining !== 0 ||
      replay.attempts?.length !== 0
    ) {
      fail('IDEMPOTENT_REPLAY_FAILED');
    }

    await closeCurrent();
    const evidenceSession = await open();
    const evidenceContract = await discoverProgressiveTool(
      evidenceSession,
      'guild_blueprint_evidence',
      'guild_blueprint_evidence',
      PROGRESSIVE_READ_TOOL,
      ['expected_bot_id', 'guild_id', 'plan_id'],
    );
    const evidence = await dispatchProgressiveTool(evidenceSession, evidenceContract, {
      guild_id: trial.guild_id,
      expected_bot_id: trial.expected_bot_id,
      plan_id: plan.plan_id,
    });
    evidenceStatus = evidence?.status ?? null;
    if (evidenceStatus === 'verified') {
      activityEvidence = activityEvidenceSummary(evidence, plan, trial);
    } else {
      functional.push({ code: 'ACTIVITY_EVIDENCE_NOT_VERIFIED' });
    }

    const finalBindings = structuredClone(cleanup.bindings);
    cleanup.publication_targets = publicationTargets(plan.blueprint, finalBindings);
    cleanup.message_channel_ids = [
      ...new Set([
        ...baselineMessageChannelIds,
        ...cleanup.publication_targets.map((target) => target.channel_id),
      ]),
    ].sort();
    const expectations = dependencies.buildExpectations({
      blueprint: plan.blueprint,
      bindings: cleanup.bindings,
      before,
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
    });
    let after;
    let snapshotOracle;
    let blueprintOracle;
    for (let attempt = 0; attempt < SETTLE_DELAYS_MS.length; attempt += 1) {
      await settleBeforeAttempt(dependencies, attempt);
      try {
        after = await dependencies.readSnapshot({
          guildId: trial.guild_id,
          botId: trial.expected_bot_id,
          messageChannelIds: cleanup.message_channel_ids,
        });
        snapshotOracle = dependencies.compareSnapshots(before, after, expectations);
        blueprintOracle = dependencies.verifyBlueprintSnapshot({
          blueprint: plan.blueprint,
          blueprintId: plan.blueprint_id,
          bindings: cleanup.bindings,
          snapshot: after,
          guildId: trial.guild_id,
          botId: trial.expected_bot_id,
        });
      } catch (error) {
        if (error?.code === 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET') throw error;
        snapshotOracle = undefined;
        blueprintOracle = undefined;
        continue;
      }
      if (
        (snapshotOracle.serious_permission_failures?.length ?? 0) > 0 ||
        (snapshotOracle.pass === true && blueprintOracle.match === true)
      ) {
        break;
      }
    }
    if (snapshotOracle === undefined || blueprintOracle === undefined || after === undefined) {
      fail('FINAL_STATE_ORACLE_UNAVAILABLE', { serious: true });
    }
    snapshotOraclePass = snapshotOracle.pass === true;
    blueprintOracleMatch = blueprintOracle.match === true;
    let auditTrail;
    let auditOracle;
    for (let attempt = 0; attempt < SETTLE_DELAYS_MS.length; attempt += 1) {
      await settleBeforeAttempt(dependencies, attempt);
      try {
        auditTrail = await dependencies.readAuditTrail({
          guildId: trial.guild_id,
          botId: trial.expected_bot_id,
          afterEntryId: auditCursor,
        });
        auditOracle = dependencies.verifyAuditTrail({
          entries: auditTrail.entries,
          complete: auditTrail.complete,
          botId: trial.expected_bot_id,
          guildId: trial.guild_id,
          blueprintId: plan.blueprint_id,
          bindings: cleanup.bindings,
          expected: expectations,
          beforeSnapshot: before,
          snapshot: after,
        });
      } catch (error) {
        if (error?.code === 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET') throw error;
        auditTrail = undefined;
        auditOracle = undefined;
        continue;
      }
      if (
        (auditOracle.serious_permission_failures?.length ?? 0) > 0 ||
        (auditTrail.complete === true && auditTrail.entries.length > 0 && auditOracle.pass === true)
      ) {
        break;
      }
    }
    if (auditTrail === undefined || auditOracle === undefined) {
      fail('AUDIT_OBSERVER_UNAVAILABLE', { serious: true });
    }
    auditOraclePass = auditOracle.pass === true;
    auditEntryCount = auditTrail.entries?.length ?? 0;
    auditTrailComplete = auditTrail.complete === true;
    serious.push(
      ...(snapshotOracle.serious_permission_failures ?? []),
      ...(auditOracle.serious_permission_failures ?? []),
    );
    functional.push(
      ...(snapshotOracle.functional_failures ?? []),
      ...(blueprintOracle.failures ?? []),
      ...(auditOracle.functional_failures ?? []),
    );
    verifiedCounts = blueprintOracle.verified_counts ?? null;
  } catch (error) {
    const failure = safeFailure(error);
    terminalStatus = failure.terminalStatus;
    const target = failure.serious ? serious : functional;
    if (!target.some((item) => item.code === failure.code)) target.push({ code: failure.code });
  } finally {
    try {
      await closeCurrent();
    } catch {
      terminalStatus = 'error';
      if (!functional.some((item) => item.code === 'SESSION_CLOSE_FAILED')) {
        functional.push({ code: 'SESSION_CLOSE_FAILED' });
      }
    }
  }

  if (
    !sessionTerminationUncertain &&
    plan !== undefined &&
    applyCalls > 0 &&
    (lastApplyResultUnavailable || cleanup.bindings === null)
  ) {
    try {
      const checkpoint = await dependencies.loadCheckpoint({
        stateDirectory: input.stateDirectory,
        planId: plan.plan_id,
      });
      if (checkpoint === null) {
        fail('CHECKPOINT_RECOVERY_REJECTED', { serious: true });
      }
      cleanup.bindings = recoverCheckpointBindings(
        checkpoint,
        plan,
        trial,
        cleanup.bindings,
        latestCheckpointVersion,
      );
    } catch {
      if (!serious.some((item) => item.code === 'CHECKPOINT_RECOVERY_REJECTED')) {
        serious.push({ code: 'CHECKPOINT_RECOVERY_REJECTED' });
      }
    }
  }

  if (sessionTerminationUncertain) {
    cleanup.bindings = null;
    cleanup.message_channel_ids = [];
    cleanup.publication_targets = [];
    if (!serious.some((item) => item.code === 'SESSION_TERMINATION_UNCONFIRMED')) {
      serious.push({ code: 'SESSION_TERMINATION_UNCONFIRMED' });
    }
  }

  if (plan !== undefined && cleanup.bindings !== null) {
    try {
      cleanup.publication_targets = publicationTargets(plan.blueprint, cleanup.bindings, {
        requireComplete: terminalStatus === 'complete',
      });
      cleanup.message_channel_ids = [
        ...new Set([
          ...baselineMessageChannelIds,
          ...cleanup.publication_targets.map((target) => target.channel_id),
        ]),
      ].sort();
    } catch {
      serious.push({ code: 'CLEANUP_METADATA_INVALID' });
    }
  }

  const restartCount = Math.max(0, sessionOpenCount - 1);
  const lifecycleMatch =
    planSnapshotUnchanged &&
    operationsPlanned > 0 &&
    applyCalls > 0 &&
    auditTrailComplete &&
    auditEntryCount > 0 &&
    verifiedCounts !== null &&
    Object.values(verifiedCounts).every((count) => Number.isInteger(count) && count > 0) &&
    (trial.mode === 'forced_resume'
      ? forcedResumeObserved && restartCount >= 2
      : restartCount >= 1);
  const oracleMatch =
    terminalStatus === 'complete' &&
    serious.length === 0 &&
    functional.length === 0 &&
    replayStatus === 'already_current' &&
    evidenceStatus === 'verified' &&
    snapshotOraclePass &&
    blueprintOracleMatch &&
    auditOraclePass &&
    lifecycleMatch;
  return {
    result: {
      trial_id: trial.trial_id,
      mode: trial.mode,
      guild_id: trial.guild_id,
      plan_id: plan?.plan_id ?? null,
      blueprint_id: plan?.blueprint_id ?? null,
      eligible: true,
      terminal_status: terminalStatus,
      oracle_match: oracleMatch,
      snapshot_oracle_pass: snapshotOraclePass,
      blueprint_oracle_match: blueprintOracleMatch,
      audit_oracle_pass: auditOraclePass,
      serious_permission_failures: serious,
      functional_failures: functional,
      plan_snapshot_unchanged: planSnapshotUnchanged,
      progressive_discovery_succeeded: progressiveDiscoverySucceeded,
      dry_run_observed_before_apply: dryRunObservedBeforeApply,
      apply_result_loss_observed: applyResultLossObserved,
      apply_result_loss_recovered: applyResultLossRecovered,
      forced_resume_observed: trial.mode === 'forced_resume' ? forcedResumeObserved : null,
      operations_planned: operationsPlanned,
      apply_calls: applyCalls,
      restart_count: restartCount,
      replay_status: replayStatus,
      evidence_status: evidenceStatus,
      audit_entry_count: auditEntryCount,
      audit_trail_complete: auditTrailComplete,
      verified_counts: verifiedCounts,
      last_nonterminal_apply: lastNonterminalApply,
      template_evidence: templateEvidence,
      activity_evidence: activityEvidence,
    },
    cleanup,
  };
}
