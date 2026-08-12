const SUCCESS_STATUSES = new Set(['complete', 'already_current']);
const NEXT_ACTIONS = new Set(['done', 'resume', 'replan', 'fix_configuration']);
const SNOWFLAKE = /^\d{17,20}$/;
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
  assertRecord(plan, 'PLAN_RESPONSE_INVALID');
  if (plan.status !== 'ready') {
    fail('PLAN_NOT_READY', {
      terminalStatus: ['blocked', 'no_match'].includes(plan.status) ? 'blocked' : 'error',
    });
  }
  assertTarget(plan.target, trial, 'PLAN_TARGET_MISMATCH');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(plan.blueprint_id ?? '') ||
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

export { publicationTargets };

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
      } catch (error) {
        lastApplyResultUnavailable = true;
        if (!retryableSessionError(error) || !(await recoverApply.recover(error))) throw error;
        continue;
      }
      lastApplyResultUnavailable = false;
      const result = validateApply(rawApply, plan, trial);
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
    const evidenceVerified =
      evidence?.status === 'verified' &&
      evidence?.plan_id === plan.plan_id &&
      evidence?.blueprint_id === plan.blueprint_id &&
      evidence?.target?.guild_id === trial.guild_id &&
      evidence?.target?.bot_id === trial.expected_bot_id &&
      evidence?.verification?.identity_verified === true &&
      evidence?.verification?.guild_verified === true &&
      evidence?.verification?.readback === 'match';
    if (!evidenceVerified) functional.push({ code: 'ACTIVITY_EVIDENCE_NOT_VERIFIED' });

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
    },
    cleanup,
  };
}
