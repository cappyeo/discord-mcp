export const BLUEPRINT_TEXT_RECEIPT_PREFIX = 'MCP_BLUEPRINT_RECEIPT ';
export const BLUEPRINT_TEXT_RECEIPT_SCHEMA = 'discord_mcp_blueprint_text_receipt.v1';

const SNOWFLAKE = /^\d{17,20}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PLAN_REF = /^dmbpr1\.[a-f0-9]{64}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const APPLY_STATUSES = new Set([
  'complete',
  'already_current',
  'partial',
  'blocked',
  'busy',
  'stale',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected, code) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
    fail(code);
}

function digest(value, code) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(code);
  return value;
}

function planRef(value, code) {
  if (typeof value !== 'string' || !PLAN_REF.test(value)) fail(code);
  return value;
}

function nonnegative(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function hasForbiddenKey(value, key, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, key, depth + 1));
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasForbiddenKey(item, key, depth + 1));
}

function target(value) {
  if (!record(value)) fail('RECEIPT_TARGET_INVALID');
  exactKeys(value, ['guild_id', 'bot_id'], 'RECEIPT_TARGET_INVALID');
  if (!SNOWFLAKE.test(value.guild_id ?? '') || !SNOWFLAKE.test(value.bot_id ?? ''))
    fail('RECEIPT_TARGET_INVALID');
  return { guild_id: value.guild_id, bot_id: value.bot_id };
}

function parsePlan(receipt) {
  exactKeys(
    receipt,
    [
      'schema_version',
      'phase',
      'status',
      'target',
      'plan_id',
      'blueprint_id',
      'approval_id',
      'plan_ref',
    ],
    'RECEIPT_SHAPE_INVALID',
  );
  if (!['ready', 'already_current'].includes(receipt.status)) fail('RECEIPT_STATUS_INVALID');
  return {
    ...receipt,
    target: target(receipt.target),
    plan_id: digest(receipt.plan_id, 'RECEIPT_PLAN_ID_INVALID'),
    blueprint_id: digest(receipt.blueprint_id, 'RECEIPT_BLUEPRINT_ID_INVALID'),
    approval_id: digest(receipt.approval_id, 'RECEIPT_APPROVAL_ID_INVALID'),
    plan_ref:
      receipt.plan_ref === null ? null : planRef(receipt.plan_ref, 'RECEIPT_PLAN_REF_INVALID'),
  };
}

function parseApply(receipt) {
  exactKeys(
    receipt,
    [
      'schema_version',
      'phase',
      'status',
      'target',
      'plan_id',
      'blueprint_id',
      'progress',
      'error',
      'evidence_id',
      'next_action',
    ],
    'RECEIPT_SHAPE_INVALID',
  );
  if (!APPLY_STATUSES.has(receipt.status)) fail('RECEIPT_STATUS_INVALID');
  if (!record(receipt.progress)) fail('RECEIPT_PROGRESS_INVALID');
  exactKeys(
    receipt.progress,
    ['completed_total', 'remaining', 'checkpoint_version'],
    'RECEIPT_PROGRESS_INVALID',
  );
  const checkpointVersion = receipt.progress.checkpoint_version;
  if (checkpointVersion !== null) nonnegative(checkpointVersion, 'RECEIPT_PROGRESS_INVALID');
  let error = null;
  if (receipt.error !== null) {
    if (!record(receipt.error)) fail('RECEIPT_ERROR_INVALID');
    exactKeys(receipt.error, ['code', 'retry_after_ms'], 'RECEIPT_ERROR_INVALID');
    if (typeof receipt.error.code !== 'string' || !SAFE_ERROR_CODE.test(receipt.error.code))
      fail('RECEIPT_ERROR_INVALID');
    if (receipt.error.retry_after_ms !== null)
      nonnegative(receipt.error.retry_after_ms, 'RECEIPT_ERROR_INVALID');
    error = { code: receipt.error.code, retry_after_ms: receipt.error.retry_after_ms };
  }
  if (!['done', 'resume', 'replan', 'fix_configuration'].includes(receipt.next_action))
    fail('RECEIPT_NEXT_ACTION_INVALID');
  return {
    ...receipt,
    target: target(receipt.target),
    plan_id: receipt.plan_id === null ? null : digest(receipt.plan_id, 'RECEIPT_PLAN_ID_INVALID'),
    blueprint_id:
      receipt.blueprint_id === null
        ? null
        : digest(receipt.blueprint_id, 'RECEIPT_BLUEPRINT_ID_INVALID'),
    progress: {
      completed_total: nonnegative(receipt.progress.completed_total, 'RECEIPT_PROGRESS_INVALID'),
      remaining: nonnegative(receipt.progress.remaining, 'RECEIPT_PROGRESS_INVALID'),
      checkpoint_version: checkpointVersion,
    },
    error,
    evidence_id:
      receipt.evidence_id === null
        ? null
        : digest(receipt.evidence_id, 'RECEIPT_EVIDENCE_ID_INVALID'),
  };
}

function parseEvidence(receipt) {
  exactKeys(
    receipt,
    [
      'schema_version',
      'phase',
      'status',
      'target',
      'plan_id',
      'blueprint_id',
      'evidence_id',
      'verification',
    ],
    'RECEIPT_SHAPE_INVALID',
  );
  if (!['verified', 'drifted', 'not_found', 'blocked'].includes(receipt.status))
    fail('RECEIPT_STATUS_INVALID');
  if (!record(receipt.verification)) fail('RECEIPT_VERIFICATION_INVALID');
  exactKeys(
    receipt.verification,
    [
      'identity_verified',
      'guild_verified',
      'readback',
      'snapshot_unchanged',
      'remaining',
      'blockers',
    ],
    'RECEIPT_VERIFICATION_INVALID',
  );
  if (
    typeof receipt.verification.identity_verified !== 'boolean' ||
    typeof receipt.verification.guild_verified !== 'boolean' ||
    !['match', 'drift', 'not_run'].includes(receipt.verification.readback) ||
    ![true, false, null].includes(receipt.verification.snapshot_unchanged)
  )
    fail('RECEIPT_VERIFICATION_INVALID');
  return {
    ...receipt,
    target: target(receipt.target),
    plan_id: digest(receipt.plan_id, 'RECEIPT_PLAN_ID_INVALID'),
    blueprint_id:
      receipt.blueprint_id === null
        ? null
        : digest(receipt.blueprint_id, 'RECEIPT_BLUEPRINT_ID_INVALID'),
    evidence_id:
      receipt.evidence_id === null
        ? null
        : digest(receipt.evidence_id, 'RECEIPT_EVIDENCE_ID_INVALID'),
    verification: {
      ...receipt.verification,
      remaining: nonnegative(receipt.verification.remaining, 'RECEIPT_VERIFICATION_INVALID'),
      blockers: nonnegative(receipt.verification.blockers, 'RECEIPT_VERIFICATION_INVALID'),
    },
  };
}

/** Parse exactly one compact, secret-free blueprint receipt from a text-only MCP result. */
export function parseBlueprintTextReceipt(output, expectedPhase) {
  if (typeof output !== 'string') fail('TOOL_OUTPUT_INVALID');
  if (!['plan', 'apply', 'evidence'].includes(expectedPhase)) fail('PHASE_INVALID');
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(BLUEPRINT_TEXT_RECEIPT_PREFIX));
  if (lines.length !== 1) fail('RECEIPT_COUNT_INVALID');
  let receipt;
  try {
    receipt = JSON.parse(lines[0].slice(BLUEPRINT_TEXT_RECEIPT_PREFIX.length));
  } catch {
    fail('RECEIPT_JSON_INVALID');
  }
  if (!record(receipt) || hasForbiddenKey(receipt, 'plan_token')) fail('RECEIPT_INVALID');
  if (receipt.schema_version !== BLUEPRINT_TEXT_RECEIPT_SCHEMA || receipt.phase !== expectedPhase)
    fail('RECEIPT_BINDING_INVALID');
  if (expectedPhase === 'plan') return parsePlan(receipt);
  if (expectedPhase === 'apply') return parseApply(receipt);
  return parseEvidence(receipt);
}
