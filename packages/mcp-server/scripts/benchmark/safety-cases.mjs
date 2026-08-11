const CASES = Object.freeze(['wrong_bot', 'wrong_guild', 'write_preview']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
}

function validateInput(input) {
  if (!record(input)) throw new TypeError('safety case input is required');
  for (const name of [
    'guardGuildId',
    'wrongGuildId',
    'activeBotId',
    'wrongBotId',
    'request',
    'cliPath',
    'cwd',
    'token',
    'stateDirectory',
  ]) {
    requiredString(input[name], name);
  }
  if (!record(input.dependencies)) throw new TypeError('dependencies are required');
  for (const name of [
    'openSession',
    'readSnapshot',
    'snapshotFingerprint',
    'readAuditCursor',
    'readAuditTrail',
  ]) {
    if (typeof input.dependencies[name] !== 'function')
      throw new TypeError(`dependencies.${name} must be a function`);
  }
}

function childEnvironment(input) {
  return {
    ALLOWED_GUILDS: input.guardGuildId,
    DISCORD_EXPECTED_BOT_ID: input.activeBotId,
    DISCORD_TOKEN: input.token,
    MCP_AUDIT_ENABLED: 'true',
    MCP_BLUEPRINT_STATE_DIR: input.stateDirectory,
    MCP_DRY_RUN: 'false',
    MCP_TOOL_SURFACE: 'full',
    MCP_WRITE_MODE: 'allow',
  };
}

function messageChannelIds(snapshot) {
  if (!Array.isArray(snapshot?.channels)) return [];
  return snapshot.channels
    .filter((channel) => channel?.type === 0 || channel?.type === 5)
    .map((channel) => channel.id)
    .filter((id) => typeof id === 'string' && id !== '');
}

async function readGuildSnapshot(dependencies, guildId, botId, messageIds) {
  const inventory = await dependencies.readSnapshot({
    guildId,
    botId,
    messageChannelIds: messageIds ?? [],
  });
  if (!record(inventory)) throw new Error('guard snapshot is malformed');
  const ids = messageIds === undefined ? messageChannelIds(inventory) : messageIds;
  if (messageIds === undefined && ids.length === 0) return { snapshot: inventory, messageIds: ids };
  if (messageIds !== undefined) return { snapshot: inventory, messageIds: ids };
  const snapshot = await dependencies.readSnapshot({
    guildId,
    botId,
    messageChannelIds: ids,
  });
  if (!record(snapshot)) throw new Error('guard snapshot is malformed');
  return { snapshot, messageIds: ids };
}

function monitoredGuildIds(input, caseName) {
  return caseName === 'wrong_guild'
    ? [...new Set([input.guardGuildId, input.wrongGuildId])]
    : [input.guardGuildId];
}

async function captureBefore(dependencies, guildId, botId) {
  const auditCursor = await dependencies.readAuditCursor({ guildId, botId });
  const snapshot = await readGuildSnapshot(dependencies, guildId, botId);
  const fingerprint = dependencies.snapshotFingerprint(snapshot.snapshot);
  if (typeof fingerprint !== 'string' || fingerprint === '') {
    throw new Error('guard snapshot fingerprint is malformed');
  }
  return { guildId, auditCursor, ...snapshot, fingerprint };
}

function emptyEvidence(caseName, input, targetGuildId, suppliedBotId) {
  return {
    case: caseName,
    passed: false,
    guard_guild_id: input.guardGuildId,
    target_guild_id: targetGuildId,
    active_bot_id: input.activeBotId,
    supplied_bot_id: suppliedBotId,
    blocked_before_discord: false,
    blocker_code: null,
    plan_status: 'blocked',
    target_readback: 'not_run',
    operations_planned: 0,
    snapshot_unchanged: false,
    audit_entry_count: 0,
    mutation_count: 0,
  };
}

function blockerCode(plan) {
  if (!Array.isArray(plan?.blockers)) return null;
  const blocker = plan.blockers.find((item) => typeof item?.code === 'string');
  return blocker?.code ?? null;
}

function planStatus(plan) {
  return plan?.status === 'ready' || plan?.status === 'blocked' ? plan.status : 'blocked';
}

function readback(plan) {
  return plan?.verification?.target_readback === 'passed' ? 'passed' : 'not_run';
}

function operationsPlanned(plan) {
  return Array.isArray(plan?.operations) ? plan.operations.length : 0;
}

function planShapeIsValid(plan, targetGuildId, suppliedBotId, expectedBlocker) {
  if (
    !record(plan) ||
    !['ready', 'blocked'].includes(plan.status) ||
    !Array.isArray(plan.operations) ||
    !Array.isArray(plan.blockers) ||
    !record(plan.verification) ||
    !plan.operations.every(
      (operation) => record(operation) && typeof operation.operation_id === 'string',
    )
  ) {
    return false;
  }
  if (expectedBlocker !== null) {
    return (
      plan.status === 'blocked' &&
      plan.target === null &&
      plan.verification.target_readback === 'not_run' &&
      plan.operations.length === 0 &&
      plan.blockers.length > 0 &&
      plan.blockers.some((blocker) => blocker?.code === expectedBlocker)
    );
  }
  return (
    plan.status === 'ready' &&
    record(plan.target) &&
    plan.target.guild_id === targetGuildId &&
    plan.target.bot_id === suppliedBotId &&
    plan.verification.target_readback === 'passed' &&
    plan.blockers.length === 0
  );
}

function evidencePass(evidence, expectedBlocker) {
  const noMutation =
    evidence.snapshot_unchanged === true &&
    evidence.audit_entry_count === 0 &&
    evidence.mutation_count === 0;
  if (!noMutation) return false;
  if (expectedBlocker !== null) {
    return (
      evidence.blocked_before_discord === true &&
      evidence.blocker_code === expectedBlocker &&
      evidence.plan_status === 'blocked' &&
      evidence.target_readback === 'not_run' &&
      evidence.operations_planned === 0
    );
  }
  return (
    evidence.blocked_before_discord === false &&
    evidence.blocker_code === null &&
    evidence.plan_status === 'ready' &&
    evidence.target_readback === 'passed' &&
    evidence.operations_planned > 0
  );
}

async function runCase(input, caseName, dependencies) {
  const targetGuildId = caseName === 'wrong_guild' ? input.wrongGuildId : input.guardGuildId;
  const suppliedBotId = caseName === 'wrong_bot' ? input.wrongBotId : input.activeBotId;
  const expectedBlocker =
    caseName === 'wrong_bot'
      ? 'EXPECTED_BOT_MISMATCH'
      : caseName === 'wrong_guild'
        ? 'TARGET_GUILD_NOT_ALLOWED'
        : null;
  const evidence = emptyEvidence(caseName, input, targetGuildId, suppliedBotId);
  const beforeStates = [];
  for (const guildId of monitoredGuildIds(input, caseName)) {
    beforeStates.push(await captureBefore(dependencies, guildId, input.activeBotId));
  }
  let session = null;
  let plan = null;
  let callMalformed = false;
  let closeError = null;
  try {
    session = await dependencies.openSession({
      cliPath: input.cliPath,
      cwd: input.cwd,
      env: childEnvironment(input),
    });
    if (!record(session) || typeof session.callTool !== 'function')
      throw new Error('session is malformed');
    plan = await session.callTool('guild_blueprint_plan', {
      guild_id: targetGuildId,
      expected_bot_id: suppliedBotId,
      request: input.request,
    });
    if (!planShapeIsValid(plan, targetGuildId, suppliedBotId, expectedBlocker))
      throw new Error('plan response is malformed');
  } catch {
    callMalformed = true;
  } finally {
    if (session !== null) {
      if (typeof session.close !== 'function')
        closeError = new Error('session close is unavailable');
      else {
        try {
          await session.close();
        } catch (error) {
          closeError = error;
        }
      }
      session = null;
    }
  }
  if (closeError !== null) throw closeError;

  let snapshotsUnchanged = true;
  const entries = [];
  for (const before of beforeStates) {
    const after = await readGuildSnapshot(
      dependencies,
      before.guildId,
      input.activeBotId,
      before.messageIds,
    );
    const afterFingerprint = dependencies.snapshotFingerprint(after.snapshot);
    if (typeof afterFingerprint !== 'string' || afterFingerprint === '') {
      throw new Error('guard snapshot fingerprint is malformed');
    }
    snapshotsUnchanged &&= before.fingerprint === afterFingerprint;
    const auditTrail = await dependencies.readAuditTrail({
      guildId: before.guildId,
      botId: input.activeBotId,
      afterEntryId: before.auditCursor,
    });
    if (!record(auditTrail) || !Array.isArray(auditTrail.entries) || auditTrail.complete !== true) {
      throw new Error('audit trail is malformed');
    }
    entries.push(...auditTrail.entries);
  }

  evidence.snapshot_unchanged = snapshotsUnchanged;
  evidence.audit_entry_count = entries.length;
  evidence.mutation_count = entries.length;
  evidence.plan_status = planStatus(plan);
  evidence.blocker_code = blockerCode(plan);
  evidence.blocked_before_discord =
    evidence.plan_status === 'blocked' && evidence.blocker_code === expectedBlocker;
  evidence.target_readback = readback(plan);
  evidence.operations_planned = operationsPlanned(plan);
  evidence.passed = !callMalformed && evidencePass(evidence, expectedBlocker);
  return evidence;
}

export async function runBenchmarkSafetyCases({
  guardGuildId,
  wrongGuildId,
  activeBotId,
  wrongBotId,
  request,
  cliPath,
  cwd,
  token,
  stateDirectory,
  dependencies,
}) {
  const input = {
    guardGuildId,
    wrongGuildId,
    activeBotId,
    wrongBotId,
    request,
    cliPath,
    cwd,
    token,
    stateDirectory,
    dependencies,
  };
  validateInput(input);
  const evidence = [];
  for (const caseName of CASES) evidence.push(await runCase(input, caseName, dependencies));
  return evidence;
}
