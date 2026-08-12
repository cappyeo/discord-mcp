const SNOWFLAKE = /^\d{17,20}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const QUOTA_SCHEMA = 'discord-mcp.benchmark-quota-preflight.v1';
export const MAX_QUOTA_PREFLIGHT_WAIT_MS = 15 * 60_000;

export class BenchmarkQuotaPreflightError extends Error {
  constructor(code, evidence) {
    super(code);
    this.name = 'BenchmarkQuotaPreflightError';
    this.code = code;
    this.evidence = Object.freeze(structuredClone(evidence));
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMs(error) {
  const value = error?.retryAfterMs ?? error?.retry_after_ms;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function statusOf(error) {
  return Number.isInteger(error?.status) ? error.status : null;
}

function roleId(response) {
  return record(response) && typeof response.id === 'string' && SNOWFLAKE.test(response.id)
    ? response.id
    : null;
}

function isTemporaryRole(role, temporaryRoleName) {
  return (
    record(role) &&
    role.name === temporaryRoleName &&
    role.permissions === '0' &&
    role.hoist === false &&
    role.mentionable === false &&
    role.managed === false &&
    roleId(role) !== null
  );
}

function baselineRoleIds(baseline) {
  const roles = baseline.baseline_snapshot?.roles;
  if (!Array.isArray(roles)) return new Set();
  return new Set(
    roles
      .filter(record)
      .map((role) => role.id)
      .filter((id) => SNOWFLAKE.test(id)),
  );
}

function evidence({
  guildId,
  botId,
  status = null,
  createAttempts = 0,
  waitedMs = 0,
  retryAfter = null,
  temporaryRoleId = null,
  baselineFingerprint,
  baselineAfter = null,
  baselineRestored = false,
}) {
  return {
    schema_version: QUOTA_SCHEMA,
    guild_id: guildId,
    bot_id: botId,
    status,
    create_attempts: createAttempts,
    waited_ms: waitedMs,
    retry_after_ms: retryAfter,
    role_id: temporaryRoleId,
    baseline_fingerprint_before: baselineFingerprint,
    baseline_fingerprint_after: baselineAfter,
    baseline_restored: baselineRestored,
  };
}

function assertVerification(value, baseline, guildId, botId) {
  if (
    !record(value) ||
    value.verified !== true ||
    value.guild_id !== guildId ||
    value.bot_id !== botId ||
    value.fingerprint !== baseline.fingerprint
  ) {
    throw new Error('baseline verification did not prove the exact target');
  }
  return value;
}

function validateInput({ rest, verifyBaseline, sleep, baseline, guildId, botId, runId }) {
  requiredFunction(rest?.request, 'rest.request');
  requiredFunction(verifyBaseline, 'verifyBaseline');
  requiredFunction(sleep, 'sleep');
  snowflake(guildId, 'guildId');
  snowflake(botId, 'botId');
  if (!record(baseline)) throw new TypeError('baseline is required');
  if (baseline.guild_id !== guildId)
    throw new TypeError('baseline guild_id does not match guildId');
  if (baseline.bot_id !== botId) throw new TypeError('baseline bot_id does not match botId');
  digest(baseline.fingerprint, 'baseline.fingerprint');
  if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID.test(runId))) {
    throw new TypeError('runId is invalid');
  }
}

function roleName(runId, guildId) {
  return `__discord_mcp_quota_preflight_${runId ?? 'probe'}_${guildId}`.slice(0, 100);
}

function auditReason(runId) {
  return `discord-mcp benchmark quota preflight ${runId ?? 'probe'}`;
}

async function verifyExact({ verifyBaseline, baseline, guildId, botId }) {
  return assertVerification(
    await verifyBaseline({ baseline, guildId, botId }),
    baseline,
    guildId,
    botId,
  );
}

async function recoverExactBaseline({
  rest,
  verifyBaseline,
  baseline,
  guildId,
  botId,
  runId,
  temporaryRoleName,
  protectedRoleIds,
  knownRoleId = null,
}) {
  let recoveredRoleId = knownRoleId;
  try {
    const roles = await rest.request('GET', `/guilds/${guildId}/roles`, { retry: true });
    if (!Array.isArray(roles)) throw new Error('role recovery response must be an array');
    const candidates = new Set();
    for (const role of roles) {
      if (!isTemporaryRole(role, temporaryRoleName)) continue;
      const id = role.id;
      if (protectedRoleIds.has(id)) continue;
      if (knownRoleId === null || id === knownRoleId) candidates.add(id);
    }
    if (candidates.size > 1) throw new Error('role recovery target is ambiguous');
    recoveredRoleId = [...candidates][0] ?? recoveredRoleId;
    if (candidates.size === 1) {
      try {
        await rest.request('DELETE', `/guilds/${guildId}/roles/${recoveredRoleId}`, {
          reason: auditReason(runId),
          retry: true,
        });
      } catch {
        // Exact readback below remains the sole recovery success criterion.
      }
    }
    const after = await verifyExact({ verifyBaseline, baseline, guildId, botId });
    return { roleId: recoveredRoleId, after: after.fingerprint, restored: true };
  } catch {
    return { roleId: recoveredRoleId, after: null, restored: false };
  }
}

export async function probeGuildRoleCreateQuota({
  rest,
  verifyBaseline,
  baseline,
  guildId,
  botId,
  runId,
  sleep = wait,
} = {}) {
  validateInput({ rest, verifyBaseline, sleep, baseline, guildId, botId, runId });
  const baselineFingerprint = baseline.fingerprint;
  const protectedRoleIds = baselineRoleIds(baseline);
  try {
    await verifyExact({ verifyBaseline, baseline, guildId, botId });
  } catch {
    throw new BenchmarkQuotaPreflightError(
      'PREFLIGHT_BASELINE_VERIFICATION_FAILED',
      evidence({
        guildId,
        botId,
        baselineFingerprint,
      }),
    );
  }

  const temporaryRoleName = roleName(runId, guildId);
  const createOptions = {
    body: {
      name: temporaryRoleName,
      permissions: '0',
      hoist: false,
      mentionable: false,
    },
    reason: auditReason(runId),
    retry: false,
  };
  let response;
  let createAttempts = 0;
  let waitedMs = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    createAttempts += 1;
    try {
      response = await rest.request('POST', `/guilds/${guildId}/roles`, createOptions);
      break;
    } catch (error) {
      const retryAfter = retryAfterMs(error);
      if (statusOf(error) !== 429) {
        const recovery = await recoverExactBaseline({
          rest,
          verifyBaseline,
          baseline,
          guildId,
          botId,
          runId,
          temporaryRoleName,
          protectedRoleIds,
        });
        throw new BenchmarkQuotaPreflightError(
          'PREFLIGHT_ROLE_CREATE_FAILED',
          evidence({
            guildId,
            botId,
            createAttempts,
            waitedMs,
            retryAfter,
            temporaryRoleId: recovery.roleId,
            baselineFingerprint,
            baselineAfter: recovery.after,
            baselineRestored: recovery.restored,
          }),
        );
      }
      let after;
      try {
        after = await verifyExact({ verifyBaseline, baseline, guildId, botId });
      } catch {
        throw new BenchmarkQuotaPreflightError(
          'PREFLIGHT_BASELINE_VERIFICATION_FAILED',
          evidence({
            guildId,
            botId,
            createAttempts,
            waitedMs,
            retryAfter,
            baselineFingerprint,
          }),
        );
      }
      const canRetry =
        attempt === 0 && retryAfter !== null && retryAfter <= MAX_QUOTA_PREFLIGHT_WAIT_MS;
      if (canRetry) {
        await sleep(retryAfter);
        waitedMs += retryAfter;
        continue;
      }
      return evidence({
        guildId,
        botId,
        status: 'unavailable',
        createAttempts,
        waitedMs,
        retryAfter,
        baselineFingerprint,
        baselineAfter: after.fingerprint,
        baselineRestored: true,
      });
    }
  }

  const responseRoleId = roleId(response);
  const temporaryRoleId = isTemporaryRole(response, temporaryRoleName) ? response.id : null;
  const protectedRole = temporaryRoleId !== null && protectedRoleIds.has(temporaryRoleId);
  if (temporaryRoleId === null || protectedRole) {
    const recovery = await recoverExactBaseline({
      rest,
      verifyBaseline,
      baseline,
      guildId,
      botId,
      runId,
      temporaryRoleName,
      protectedRoleIds,
      knownRoleId: responseRoleId,
    });
    throw new BenchmarkQuotaPreflightError(
      'PREFLIGHT_ROLE_CREATE_RESPONSE_INVALID',
      evidence({
        guildId,
        botId,
        createAttempts,
        waitedMs,
        temporaryRoleId: recovery.roleId ?? responseRoleId,
        baselineFingerprint,
        baselineAfter: recovery.after,
        baselineRestored: recovery.restored,
      }),
    );
  }

  try {
    await rest.request('DELETE', `/guilds/${guildId}/roles/${temporaryRoleId}`, {
      reason: auditReason(runId),
      retry: true,
    });
  } catch {
    const recovery = await recoverExactBaseline({
      rest,
      verifyBaseline,
      baseline,
      guildId,
      botId,
      runId,
      temporaryRoleName,
      protectedRoleIds,
      knownRoleId: temporaryRoleId,
    });
    throw new BenchmarkQuotaPreflightError(
      'PREFLIGHT_ROLE_DELETE_FAILED',
      evidence({
        guildId,
        botId,
        createAttempts,
        waitedMs,
        temporaryRoleId: recovery.roleId,
        baselineFingerprint,
        baselineAfter: recovery.after,
        baselineRestored: recovery.restored,
      }),
    );
  }

  let after;
  try {
    after = await verifyExact({ verifyBaseline, baseline, guildId, botId });
  } catch {
    const recovery = await recoverExactBaseline({
      rest,
      verifyBaseline,
      baseline,
      guildId,
      botId,
      runId,
      temporaryRoleName,
      protectedRoleIds,
      knownRoleId: temporaryRoleId,
    });
    throw new BenchmarkQuotaPreflightError(
      'PREFLIGHT_BASELINE_VERIFICATION_FAILED',
      evidence({
        guildId,
        botId,
        createAttempts,
        waitedMs,
        temporaryRoleId: recovery.roleId,
        baselineFingerprint,
        baselineAfter: recovery.after,
        baselineRestored: recovery.restored,
      }),
    );
  }

  return evidence({
    guildId,
    botId,
    status: 'ready',
    createAttempts,
    waitedMs,
    temporaryRoleId,
    baselineFingerprint,
    baselineAfter: after.fingerprint,
    baselineRestored: true,
  });
}
