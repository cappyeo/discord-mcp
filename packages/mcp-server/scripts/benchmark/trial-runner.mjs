const SUCCESS_STATUSES = new Set(['complete', 'already_current']);
const APPLY_TERMINAL_STATUSES = new Set([
  'complete',
  'already_current',
  'blocked',
  'busy',
  'stale',
]);
const SETTLE_DELAYS_MS = Object.freeze([0, 250, 500, 1_000, 2_000, 4_000]);
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
];

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
    MCP_TOOL_SURFACE: 'full',
    MCP_WRITE_MODE: 'allow',
  };
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
    (result.error !== null && (result.error === null || typeof result.error !== 'object')) ||
    typeof result.evidence.identity_verified !== 'boolean' ||
    typeof result.evidence.guild_verified !== 'boolean' ||
    !['match', 'drift', 'not_run'].includes(result.evidence.readback) ||
    !Array.isArray(result.evidence.completed_operation_ids)
  ) {
    fail('APPLY_RESPONSE_INVALID');
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
  if (
    (result.status === 'complete' || result.status === 'already_current') &&
    progress.remaining !== 0
  ) {
    fail('APPLY_RESPONSE_INVALID');
  }
  if (result.status === 'partial' && progress.remaining < 1) fail('APPLY_RESPONSE_INVALID');
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

const SNOWFLAKE = /^\d{17,20}$/;

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

function readableMessageChannelIds(snapshot) {
  return (Array.isArray(snapshot?.channels) ? snapshot.channels : [])
    .filter((channel) => channel?.type === 0 || channel?.type === 5)
    .map((channel) => String(channel.id))
    .filter((id) => id !== '')
    .sort();
}

function safeFailure(error) {
  if (error instanceof TrialFailure) return error;
  return new TrialFailure('TRIAL_EXECUTION_FAILED');
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
  let applyCalls = 0;
  let planSnapshotUnchanged = false;
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
  let plan;
  let before;
  let baselineMessageChannelIds = [];

  const closeCurrent = async () => {
    const session = currentSession;
    currentSession = null;
    if (session !== null) {
      try {
        await session.close();
      } catch {
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

  try {
    const auditCursor = await dependencies.readAuditCursor({
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
    });
    const inventory = await dependencies.readSnapshot({
      guildId: trial.guild_id,
      botId: trial.expected_bot_id,
      messageChannelIds: [],
    });
    baselineMessageChannelIds = readableMessageChannelIds(inventory);
    before =
      baselineMessageChannelIds.length === 0
        ? inventory
        : await dependencies.readSnapshot({
            guildId: trial.guild_id,
            botId: trial.expected_bot_id,
            messageChannelIds: baselineMessageChannelIds,
          });
    const beforeFingerprint = dependencies.snapshotFingerprint(before);

    const session = await open();
    plan = validatePlan(
      await session.callTool('guild_blueprint_plan', {
        guild_id: trial.guild_id,
        expected_bot_id: trial.expected_bot_id,
        request: input.request,
      }),
      trial,
    );
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

    let latestApply;
    if (trial.mode === 'forced_resume') {
      latestApply = validateApply(
        await session.callTool('guild_blueprint_apply', applyArgs(input, plan, 1)),
        plan,
        trial,
      );
      applyCalls += 1;
      if (
        latestApply.status !== 'partial' ||
        latestApply.progress.attempted_this_call !== 1 ||
        latestApply.progress.remaining < 1
      ) {
        fail('FORCED_RESUME_NOT_OBSERVED');
      }
      forcedResumeObserved = true;
      cleanup.bindings = structuredClone(latestApply.evidence.bindings);
      await closeCurrent();
      await open();
    }

    for (let iteration = 0; iteration < 8; iteration += 1) {
      if (latestApply !== undefined && latestApply.status !== 'partial') break;
      latestApply = validateApply(
        await currentSession.callTool('guild_blueprint_apply', applyArgs(input, plan, 50)),
        plan,
        trial,
      );
      applyCalls += 1;
      cleanup.bindings = structuredClone(latestApply.evidence.bindings);
      if (APPLY_TERMINAL_STATUSES.has(latestApply.status)) break;
    }
    if (latestApply === undefined) fail('APPLY_RESPONSE_INVALID');
    terminalStatus = latestApply.status;
    if (latestApply.status !== 'complete') {
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

    const replay = validateApply(
      await currentSession.callTool('guild_blueprint_apply', applyArgs(input, plan, 50)),
      plan,
      trial,
    );
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
    const evidence = await evidenceSession.callTool('guild_blueprint_evidence', {
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
      } catch {
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
      } catch {
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
      forced_resume_observed: trial.mode === 'forced_resume' ? forcedResumeObserved : null,
      operations_planned: operationsPlanned,
      apply_calls: applyCalls,
      restart_count: restartCount,
      replay_status: replayStatus,
      evidence_status: evidenceStatus,
      audit_entry_count: auditEntryCount,
      audit_trail_complete: auditTrailComplete,
      verified_counts: verifiedCounts,
    },
    cleanup,
  };
}
