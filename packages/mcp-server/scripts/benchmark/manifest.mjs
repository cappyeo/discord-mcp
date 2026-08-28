import { createHash } from 'node:crypto';

/**
 * JSON-only manifest boundary for the real Discord benchmark.
 *
 * This module deliberately has no Discord or MCP dependencies. It is the
 * first trust boundary for benchmark inputs and reports: malformed plans and
 * credential-shaped data must fail before a runner can spawn a server or make
 * a request.
 */

export const BENCHMARK_SCHEMA = 'discord-mcp.real-benchmark.v2';
export const REPORT_SCHEMA = 'discord-mcp.real-benchmark-result.v2';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const TRIAL_MODES = new Set(['full', 'forced_resume']);
const TERMINAL_STATUSES = new Set([
  'complete',
  'already_current',
  'partial',
  'blocked',
  'busy',
  'stale',
  'error',
]);
const SAFETY_CASES = new Set(['wrong_bot', 'wrong_guild', 'write_preview']);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const BUILD_GRAPH_MAX_FILES = 256;
const BUILD_GRAPH_MAX_PATH_LENGTH = 200;
const BUILD_GRAPH_PATH_RE = /^packages\/mcp-(?:server|core)\/dist\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const TEMPLATE_CODE_RE = /^[a-zA-Z0-9_-]{1,100}$/;
// Must match the production template recommendation vocabularies. These
// strings are the only candidate justification allowed into a report.
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
const ACTIVITY_SCHEMA = 'guild_blueprint_activity_evidence.v1';
const ACTIVITY_BODY_KEYS = new Set([
  'schema_version',
  'recorded_at',
  'plan_id',
  'blueprint_id',
  'target',
  'blueprint',
  'initial_operation_count',
  'plan_invariants',
  'observed',
]);
const ACTIVITY_EVIDENCE_KEYS = new Set([
  'schema_version',
  'evidence_id',
  'recorded_at',
  'digest_verified',
  'plan_id',
  'blueprint_id',
  'target',
  'initial_snapshot_id',
  'final_snapshot_id',
  'current_snapshot_id',
  'initial_operation_count',
  'checkpoint_version',
  'completed_operation_count',
  'blueprint_readback_match',
  'identity_verified',
  'guild_verified',
  'readback',
  'snapshot_unchanged',
  'evidence_body',
  'expected_counts',
  'blueprint_counts',
  'safety_policy',
]);
const VERIFIED_COUNT_KEYS = new Set([
  'roles',
  'categories',
  'channels',
  'automod_rules',
  'publications',
  'onboarding_prompts',
  'onboarding_options',
]);
const MANIFEST_KEYS = new Set([
  'schema_version',
  'run_id',
  'commit',
  'not_before',
  'started_at',
  'request',
  'built_cli',
  'api_version',
  'reuse_policy',
  'guild_diversity',
  'trials',
]);
const TRIAL_KEYS = new Set(['trial_id', 'mode', 'guild_id', 'expected_bot_id', 'profile']);
const RESULT_KEYS = new Set([
  'trial_id',
  'mode',
  'guild_id',
  'plan_id',
  'blueprint_id',
  'eligible',
  'terminal_status',
  'oracle_match',
  'snapshot_oracle_pass',
  'blueprint_oracle_match',
  'audit_oracle_pass',
  'serious_permission_failures',
  'functional_failures',
  'plan_snapshot_unchanged',
  'progressive_discovery_succeeded',
  'dry_run_observed_before_apply',
  'apply_result_loss_observed',
  'apply_result_loss_recovered',
  'forced_resume_observed',
  'operations_planned',
  'apply_calls',
  'restart_count',
  'replay_status',
  'evidence_status',
  'audit_entry_count',
  'audit_trail_complete',
  'verified_counts',
  'last_nonterminal_apply',
  'baseline_verified_before',
  'baseline_restored_after',
  'baseline_fingerprint_before',
  'baseline_fingerprint_after',
  'baseline_restore_attempts',
  'template_evidence',
  'activity_evidence',
]);
const REUSE_POLICY_KEYS = new Set(['strategy', 'max_trials_per_guild', 'rationale']);
const DIVERSITY_KEYS = new Set(['total_trial_count', 'unique_guild_count', 'trials_per_guild']);
const BUILT_CLI_KEYS = new Set([
  'entrypoint',
  'sha256',
  'source_commit',
  'core_entrypoint',
  'core_sha256',
  'core_source_commit',
  'files',
  'core_files',
]);
const BUILT_FILE_KEYS = new Set(['path', 'sha256']);
const SECRET_KEY_WORDS = [
  'token',
  'authorization',
  'bearer',
  'apikey',
  'password',
  'cookie',
  'secret',
  'credential',
];
const SAFE_USAGE_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'total_tokens',
]);
const SECRET_VALUE_RE =
  /\b(?:(?:bot|bearer)\s+[a-z0-9._-]{20,}|(?:plan[\s_.-]*token|token|authorization|api[\s_.-]*key|password|cookie|secret|credential)\s*[:=]\s*\S+)/i;
// Discord bot/user tokens have three dot-separated base64url segments. Keep
// this detector conservative: it is only a persistence boundary, not a token
// parser, and deliberately never includes the matched value in an error.
const DISCORD_TOKEN_VALUE_RE =
  /(?:^|[^a-z0-9_-])(?:mfa\.[a-z0-9_-]{20,}|[a-z0-9_-]{20,30}\.[a-z0-9_-]{6}\.[a-z0-9_-]{25,})(?:$|[^a-z0-9_-])/i;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  const normalized = normalizeKey(key);
  return SECRET_KEY_WORDS.some((word) => normalized.includes(word));
}

function scanSecrets(value, path = '$', ancestors = new WeakSet(), errors = []) {
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value) || DISCORD_TOKEN_VALUE_RE.test(value)) {
      errors.push(`${path}: secret-bearing value is not allowed`);
    }
    return errors;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') return errors;
  if (typeof value !== 'object') {
    errors.push(`${path}: only JSON values are allowed`);
    return errors;
  }
  if (ancestors.has(value)) {
    errors.push(`${path}: cyclic values are not allowed`);
    return errors;
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        scanSecrets(item, `${path}[${index}]`, ancestors, errors);
      }
      return errors;
    }
    if (!isRecord(value)) {
      errors.push(`${path}: only plain JSON objects are allowed`);
      return errors;
    }

    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const isSafeUsageCount =
        SAFE_USAGE_KEYS.has(key) && Number.isSafeInteger(child) && child >= 0;
      const isSecretFreeAttestation = key === 'secret_free' && typeof child === 'boolean';
      if (!isSafeUsageCount && !isSecretFreeAttestation && isSecretKey(key))
        errors.push(`${childPath}: secret-bearing key is not allowed`);
      scanSecrets(child, childPath, ancestors, errors);
    }
    return errors;
  } finally {
    ancestors.delete(value);
  }
}

export function assertSecretFreeJson(value, path = '$') {
  const errors = scanSecrets(value, path);
  if (errors.length > 0)
    throw new TypeError(`Secret-bearing benchmark artifact: ${errors.join('; ')}`);
  return value;
}

function checkKeys(value, allowed, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path}: expected a plain object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

function cloneJson(value) {
  return structuredClone(value);
}

function calculateDiversity(trials) {
  const trialsPerGuild = {};
  for (const trial of trials) {
    trialsPerGuild[trial.guild_id] = (trialsPerGuild[trial.guild_id] ?? 0) + 1;
  }
  return {
    total_trial_count: trials.length,
    unique_guild_count: Object.keys(trialsPerGuild).length,
    trials_per_guild: trialsPerGuild,
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validFailureArray(value) {
  return Array.isArray(value);
}

function validVerifiedCounts(value) {
  if (!isRecord(value)) return false;
  if (!sameJson([...Object.keys(value)].sort(), [...VERIFIED_COUNT_KEYS].sort())) return false;
  return Object.values(value).every((count) => Number.isInteger(count) && count > 0);
}

function validTemplateCandidate(value) {
  if (!isRecord(value)) return false;
  if (
    !TEMPLATE_CODE_RE.test(value.code ?? '') ||
    typeof value.catalog_version !== 'string' ||
    value.catalog_version.trim() === '' ||
    !validTimestamp(value.fetched_at) ||
    value.use_url !== `https://discord.new/${value.code}` ||
    value.verified !== true ||
    value.code_match !== true ||
    value.permission_handling !== 'discarded_and_regenerated' ||
    !DIGEST_RE.test(value.evidence_digest ?? '')
  ) {
    return false;
  }
  if (
    !Array.isArray(value.contributes) ||
    !Array.isArray(value.structural_contributions) ||
    new Set(value.contributes).size !== value.contributes.length ||
    new Set(value.structural_contributions).size !== value.structural_contributions.length ||
    value.contributes.some((item) => !RECOMMENDATION_CAPABILITIES.has(item)) ||
    value.structural_contributions.some((item) => !STRUCTURAL_DIMENSIONS.has(item))
  ) {
    return false;
  }
  const sourceGuild = value.source_guild;
  return (
    isRecord(sourceGuild) &&
    isSnowflake(sourceGuild.id) &&
    (sourceGuild.snapshot_id === null || typeof sourceGuild.snapshot_id === 'string') &&
    (sourceGuild.icon_hash === null || typeof sourceGuild.icon_hash === 'string') &&
    (sourceGuild.preferred_locale === null || typeof sourceGuild.preferred_locale === 'string')
  );
}

function validTemplateEvidence(value) {
  if (!isRecord(value) || !validTemplateCandidate(value.primary)) return false;
  if (!Array.isArray(value.inspirations) || value.inspirations.length > 3) return false;
  const candidates = [value.primary, ...value.inspirations];
  return (
    (value.primary.contributes.length > 0 || value.primary.structural_contributions.length > 0) &&
    new Set(candidates.map((candidate) => candidate.code)).size === candidates.length &&
    new Set(candidates.map((candidate) => candidate.catalog_version)).size === 1 &&
    value.inspirations.every(
      (candidate) =>
        validTemplateCandidate(candidate) &&
        (candidate.contributes.length > 0 || candidate.structural_contributions.length > 0),
    )
  );
}

function validateBuiltFileMap(
  value,
  expectedPrefix,
  expectedEntrypoint,
  expectedDigest,
  path,
  errors,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > BUILD_GRAPH_MAX_FILES) {
    errors.push(`${path}: must contain 1-${BUILD_GRAPH_MAX_FILES} files`);
    return;
  }
  let previousPath = '';
  let entrypointCount = 0;
  const seen = new Set();
  for (const [index, file] of value.entries()) {
    const filePath = `${path}[${index}]`;
    checkKeys(file, BUILT_FILE_KEYS, filePath, errors);
    if (!isRecord(file)) continue;
    if (
      typeof file.path !== 'string' ||
      file.path.length > BUILD_GRAPH_MAX_PATH_LENGTH ||
      !BUILD_GRAPH_PATH_RE.test(file.path) ||
      !file.path.startsWith(expectedPrefix) ||
      file.path.includes('\\') ||
      file.path.includes('/./') ||
      file.path.includes('/../')
    ) {
      errors.push(`${filePath}.path: must be a safe top-level JavaScript path`);
    }
    if (!DIGEST_RE.test(file.sha256 ?? '')) {
      errors.push(`${filePath}.sha256: must be a sha256 digest`);
    }
    if (seen.has(file.path)) errors.push(`${filePath}.path: duplicate path`);
    seen.add(file.path);
    if (previousPath !== '' && file.path <= previousPath) {
      errors.push(`${path}: paths must be strictly sorted and unique`);
    }
    previousPath = file.path;
    if (file.path === expectedEntrypoint) {
      entrypointCount += 1;
      if (file.sha256 !== expectedDigest) {
        errors.push(`${filePath}.sha256: must match the attested entrypoint digest`);
      }
    }
  }
  if (entrypointCount !== 1)
    errors.push(`${path}: must contain the attested entrypoint exactly once`);
}

const ACTIVITY_COUNT_KEYS = new Set([
  'identity',
  'roles',
  'categories',
  'channels',
  'ordering',
  'guild',
  'welcome_screen',
  'onboarding',
  'automod',
  'components_v2',
]);

const BLUEPRINT_COUNT_KEYS = new Set([
  'roles',
  'categories',
  'channels',
  'automod_rules',
  'publications',
  'onboarding_prompts',
  'onboarding_options',
]);

const DIRECT_ACTIVITY_COUNT_MAP = Object.freeze({
  roles: 'roles',
  categories: 'categories',
  channels: 'channels',
  automod: 'automod_rules',
  components_v2: 'publications',
});

function validTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function strictRfc3339Milliseconds(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const zoneMatch = zone === 'Z' ? null : /([+-])(\d{2}):(\d{2})/.exec(zone);
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zoneMatch !== null && (Number(zoneMatch[2]) > 23 || Number(zoneMatch[3]) > 59))
  ) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function validStrictRfc3339(value) {
  return strictRfc3339Milliseconds(value) !== null;
}

function validActivityEvidence(value) {
  if (!isRecord(value)) return false;
  if (!sameJson([...Object.keys(value)].sort(), [...ACTIVITY_EVIDENCE_KEYS].sort())) {
    return false;
  }
  const body = value.evidence_body;
  if (
    value.schema_version !== ACTIVITY_SCHEMA ||
    !DIGEST_RE.test(value.evidence_id ?? '') ||
    !validTimestamp(value.recorded_at) ||
    value.digest_verified !== true ||
    !DIGEST_RE.test(value.plan_id ?? '') ||
    !DIGEST_RE.test(value.blueprint_id ?? '') ||
    !isSnowflake(value.target?.guild_id) ||
    !isSnowflake(value.target?.bot_id) ||
    !DIGEST_RE.test(value.initial_snapshot_id ?? '') ||
    !DIGEST_RE.test(value.final_snapshot_id ?? '') ||
    !DIGEST_RE.test(value.current_snapshot_id ?? '') ||
    !Number.isInteger(value.initial_operation_count) ||
    value.initial_operation_count < 0 ||
    !Number.isInteger(value.checkpoint_version) ||
    value.checkpoint_version < 0 ||
    !Number.isInteger(value.completed_operation_count) ||
    value.completed_operation_count < 0 ||
    value.completed_operation_count > value.initial_operation_count ||
    value.blueprint_readback_match !== true ||
    value.identity_verified !== true ||
    value.guild_verified !== true ||
    value.readback !== 'match' ||
    typeof value.snapshot_unchanged !== 'boolean' ||
    !isRecord(value.expected_counts) ||
    !sameJson([...Object.keys(value.expected_counts)].sort(), [...ACTIVITY_COUNT_KEYS].sort()) ||
    !Object.values(value.expected_counts).every((count) => Number.isInteger(count) && count >= 0) ||
    !isRecord(value.blueprint_counts) ||
    !sameJson([...Object.keys(value.blueprint_counts)].sort(), [...BLUEPRINT_COUNT_KEYS].sort()) ||
    !Object.values(value.blueprint_counts).every(
      (count) => Number.isInteger(count) && count >= 0,
    ) ||
    !isRecord(value.safety_policy) ||
    value.safety_policy.source_permissions_applied !== false ||
    value.safety_policy.dangerous_generated_permissions !== 0 ||
    value.safety_policy.bot_permission_grants !== 0 ||
    value.safety_policy.discord_managed_role_mutations !== 0
  ) {
    return false;
  }
  if (
    !isRecord(body) ||
    !sameJson([...Object.keys(body)].sort(), [...ACTIVITY_BODY_KEYS].sort()) ||
    body.schema_version !== ACTIVITY_SCHEMA ||
    body.recorded_at !== value.recorded_at ||
    body.plan_id !== value.plan_id ||
    body.blueprint_id !== value.blueprint_id ||
    !isRecord(body.target) ||
    !sameJson(Object.keys(body.target).sort(), ['bot_id', 'guild_id']) ||
    body.target.guild_id !== value.target.guild_id ||
    body.target.bot_id !== value.target.bot_id ||
    !isRecord(body.blueprint) ||
    !nonnegativeInteger(body.initial_operation_count) ||
    body.initial_operation_count !== value.initial_operation_count ||
    !isRecord(body.plan_invariants) ||
    !isRecord(body.plan_invariants.expected_counts) ||
    !sameJson(body.plan_invariants.expected_counts, value.expected_counts) ||
    !isRecord(body.plan_invariants.safety_policy) ||
    !sameJson(body.plan_invariants.safety_policy, value.safety_policy) ||
    !isRecord(body.observed) ||
    body.observed.initial_snapshot_id !== value.initial_snapshot_id ||
    body.observed.final_snapshot_id !== value.final_snapshot_id ||
    body.observed.checkpoint_version !== value.checkpoint_version ||
    body.observed.blueprint_readback_match !== value.blueprint_readback_match ||
    !Array.isArray(body.observed.completed_operation_ids) ||
    body.observed.completed_operation_ids.length !== value.completed_operation_count ||
    body.observed.completed_operation_ids.some(
      (operationId) =>
        typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 160,
    ) ||
    new Set(body.observed.completed_operation_ids).size !==
      body.observed.completed_operation_ids.length ||
    canonicalDigest(body) !== value.evidence_id
  ) {
    return false;
  }
  return (
    (value.snapshot_unchanged === false || value.current_snapshot_id === value.final_snapshot_id) &&
    value.expected_counts.onboarding ===
      1 + value.blueprint_counts.onboarding_prompts + value.blueprint_counts.onboarding_options
  );
}

function evidencePassesTemplateAndActivity(result, trial = null) {
  if (!validTemplateEvidence(result.template_evidence)) return false;
  const activity = result.activity_evidence;
  if (!validActivityEvidence(activity)) return false;
  if (
    !DIGEST_RE.test(result.plan_id ?? '') ||
    !DIGEST_RE.test(result.blueprint_id ?? '') ||
    result.plan_id !== activity.plan_id ||
    result.blueprint_id !== activity.blueprint_id ||
    (trial !== null &&
      (activity.target.guild_id !== trial.guild_id ||
        activity.target.bot_id !== trial.expected_bot_id))
  ) {
    return false;
  }
  for (const [activityKey, verifiedKey] of Object.entries(DIRECT_ACTIVITY_COUNT_MAP)) {
    if (activity.expected_counts[activityKey] !== result.verified_counts?.[verifiedKey]) {
      return false;
    }
  }
  return [...VERIFIED_COUNT_KEYS].every(
    (key) => activity.blueprint_counts[key] === result.verified_counts?.[key],
  );
}

function applyResultLossEvidencePass(result) {
  return result.apply_result_loss_observed !== true || result.apply_result_loss_recovered === true;
}

export function resultEvidencePass(result, trial = null) {
  const restartPass =
    result.mode === 'forced_resume'
      ? result.forced_resume_observed === true && result.restart_count >= 2
      : result.forced_resume_observed === null && result.restart_count >= 1;
  return (
    result.eligible === true &&
    result.terminal_status === 'complete' &&
    result.snapshot_oracle_pass === true &&
    result.blueprint_oracle_match === true &&
    result.audit_oracle_pass === true &&
    result.plan_snapshot_unchanged === true &&
    result.replay_status === 'already_current' &&
    result.evidence_status === 'verified' &&
    result.progressive_discovery_succeeded === true &&
    result.dry_run_observed_before_apply === true &&
    applyResultLossEvidencePass(result) &&
    result.audit_trail_complete === true &&
    result.audit_entry_count > 0 &&
    result.baseline_verified_before === true &&
    result.baseline_restored_after === true &&
    result.baseline_fingerprint_before === result.baseline_fingerprint_after &&
    result.operations_planned > 0 &&
    result.apply_calls > 0 &&
    validVerifiedCounts(result.verified_counts) &&
    result.serious_permission_failures.length === 0 &&
    result.functional_failures.length === 0 &&
    evidencePassesTemplateAndActivity(result, trial) &&
    restartPass
  );
}

function safetyEvidencePass(safetyCase) {
  const noMutation =
    safetyCase.snapshot_unchanged === true &&
    safetyCase.audit_entry_count === 0 &&
    safetyCase.mutation_count === 0;
  if (!noMutation) return false;
  if (safetyCase.case === 'wrong_bot') {
    return (
      safetyCase.target_guild_id === safetyCase.guard_guild_id &&
      safetyCase.supplied_bot_id !== safetyCase.active_bot_id &&
      safetyCase.blocked_before_discord === true &&
      safetyCase.blocker_code === 'EXPECTED_BOT_MISMATCH' &&
      safetyCase.plan_status === 'blocked' &&
      safetyCase.target_readback === 'not_run' &&
      safetyCase.operations_planned === 0
    );
  }
  if (safetyCase.case === 'wrong_guild') {
    return (
      safetyCase.target_guild_id !== safetyCase.guard_guild_id &&
      safetyCase.supplied_bot_id === safetyCase.active_bot_id &&
      safetyCase.blocked_before_discord === true &&
      safetyCase.blocker_code === 'GUILD_NOT_ALLOWED' &&
      safetyCase.plan_status === 'blocked' &&
      safetyCase.target_readback === 'not_run' &&
      safetyCase.operations_planned === 0
    );
  }
  return (
    safetyCase.target_guild_id === safetyCase.guard_guild_id &&
    safetyCase.supplied_bot_id === safetyCase.active_bot_id &&
    safetyCase.blocked_before_discord === false &&
    safetyCase.blocker_code === null &&
    safetyCase.plan_status === 'ready' &&
    safetyCase.target_readback === 'passed' &&
    safetyCase.operations_planned > 0
  );
}

function validateManifestShape(input, errors) {
  if (!isRecord(input)) {
    errors.push('$: expected a plain JSON object');
    return null;
  }
  checkKeys(input, MANIFEST_KEYS, '$', errors);
  if (input.schema_version !== BENCHMARK_SCHEMA)
    errors.push('$.schema_version: must be the real benchmark schema');
  if (typeof input.run_id !== 'string' || input.run_id.trim() === '' || input.run_id.length > 128) {
    errors.push('$.run_id: must contain 1-128 characters');
  }
  if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) {
    errors.push('$.commit: must be a full lowercase Git commit SHA');
  }
  if (!validStrictRfc3339(input.not_before)) {
    errors.push('$.not_before: must be a strict RFC3339 timestamp');
  }
  if (!validStrictRfc3339(input.started_at)) {
    errors.push('$.started_at: must be a strict RFC3339 timestamp');
  } else if (Date.parse(input.started_at) < Date.parse(input.not_before)) {
    errors.push('$.started_at: must be at or after $.not_before');
  }
  if (
    typeof input.request !== 'string' ||
    input.request.trim() === '' ||
    input.request.length > 500
  ) {
    errors.push('$.request: must be a nonempty string of at most 500 characters');
  }
  if (input.api_version !== '10') errors.push('$.api_version: must be 10');

  checkKeys(input.built_cli, BUILT_CLI_KEYS, '$.built_cli', errors);
  if (isRecord(input.built_cli)) {
    if (input.built_cli.entrypoint !== 'packages/mcp-server/dist/cli.js') {
      errors.push('$.built_cli.entrypoint: must be the built stdio CLI entrypoint');
    }
    if (!DIGEST_RE.test(input.built_cli.sha256 ?? '')) {
      errors.push('$.built_cli.sha256: must be a sha256 digest');
    }
    if (input.built_cli.source_commit !== input.commit) {
      errors.push('$.built_cli.source_commit: must match the manifest commit');
    }
    if (input.built_cli.core_entrypoint !== 'packages/mcp-core/dist/index.js') {
      errors.push('$.built_cli.core_entrypoint: must be the attested core entrypoint');
    }
    if (!DIGEST_RE.test(input.built_cli.core_sha256 ?? '')) {
      errors.push('$.built_cli.core_sha256: must be a sha256 digest');
    }
    if (input.built_cli.core_source_commit !== input.commit) {
      errors.push('$.built_cli.core_source_commit: must match the manifest commit');
    }
    validateBuiltFileMap(
      input.built_cli.files,
      'packages/mcp-server/dist/',
      input.built_cli.entrypoint,
      input.built_cli.sha256,
      '$.built_cli.files',
      errors,
    );
    validateBuiltFileMap(
      input.built_cli.core_files,
      'packages/mcp-core/dist/',
      input.built_cli.core_entrypoint,
      input.built_cli.core_sha256,
      '$.built_cli.core_files',
      errors,
    );
  }

  checkKeys(input.reuse_policy, REUSE_POLICY_KEYS, '$.reuse_policy', errors);
  if (isRecord(input.reuse_policy)) {
    if (!['controlled_reuse', 'unique_guilds'].includes(input.reuse_policy.strategy)) {
      errors.push('$.reuse_policy.strategy: must explicitly describe reuse');
    }
    if (
      !Number.isInteger(input.reuse_policy.max_trials_per_guild) ||
      input.reuse_policy.max_trials_per_guild < 1
    ) {
      errors.push('$.reuse_policy.max_trials_per_guild: must be a positive integer');
    }
    if (
      typeof input.reuse_policy.rationale !== 'string' ||
      input.reuse_policy.rationale.trim() === ''
    ) {
      errors.push('$.reuse_policy.rationale: must be nonempty');
    }
  }

  if (!Array.isArray(input.trials)) {
    errors.push('$.trials: must be an array');
    return null;
  }
  if (input.trials.length !== 20) errors.push('$.trials: must contain exactly 20 trials');
  const trialIds = new Set();
  const modeCounts = { full: 0, forced_resume: 0 };
  for (const [index, trial] of input.trials.entries()) {
    const path = `$.trials[${index}]`;
    checkKeys(trial, TRIAL_KEYS, path, errors);
    if (!isRecord(trial)) continue;
    if (typeof trial.trial_id !== 'string' || trial.trial_id.trim() === '') {
      errors.push(`${path}.trial_id: must be nonempty`);
    } else if (trialIds.has(trial.trial_id)) {
      errors.push(`${path}.trial_id: must be unique`);
    } else {
      trialIds.add(trial.trial_id);
    }
    if (!TRIAL_MODES.has(trial.mode)) errors.push(`${path}.mode: must be full or forced_resume`);
    else modeCounts[trial.mode] += 1;
    if (!isSnowflake(trial.guild_id)) errors.push(`${path}.guild_id: must be a Discord snowflake`);
    if (!isSnowflake(trial.expected_bot_id))
      errors.push(`${path}.expected_bot_id: must be a Discord snowflake`);
    if (typeof trial.profile !== 'string' || trial.profile.trim() === '')
      errors.push(`${path}.profile: must be nonempty`);
  }
  if (modeCounts.full !== 10) errors.push('$.trials: must contain exactly 10 full trials');
  if (modeCounts.forced_resume !== 10)
    errors.push('$.trials: must contain exactly 10 forced_resume trials');

  checkKeys(input.guild_diversity, DIVERSITY_KEYS, '$.guild_diversity', errors);
  const expectedDiversity = calculateDiversity(input.trials);
  if (!isRecord(input.guild_diversity)) return { expectedDiversity, modeCounts };
  if (input.guild_diversity.total_trial_count !== expectedDiversity.total_trial_count) {
    errors.push('$.guild_diversity.total_trial_count: does not match trials');
  }
  if (input.guild_diversity.unique_guild_count !== expectedDiversity.unique_guild_count) {
    errors.push('$.guild_diversity.unique_guild_count: does not match trials');
  }
  if (!sameJson(input.guild_diversity.trials_per_guild, expectedDiversity.trials_per_guild)) {
    errors.push('$.guild_diversity.trials_per_guild: does not match trials');
  }
  if (isRecord(input.reuse_policy)) {
    const maxTrials = Math.max(...Object.values(expectedDiversity.trials_per_guild), 0);
    if (input.reuse_policy.max_trials_per_guild < maxTrials) {
      errors.push('$.reuse_policy.max_trials_per_guild: is below actual guild reuse');
    }
    if (input.reuse_policy.strategy === 'unique_guilds' && maxTrials > 1) {
      errors.push('$.reuse_policy.strategy: unique_guilds cannot reuse a guild');
    }
  }
  return { expectedDiversity, modeCounts };
}

export function validateBenchmarkManifest(input) {
  const errors = scanSecrets(input);
  const details = validateManifestShape(input, errors);
  if (errors.length > 0 || !details) return { ok: false, errors };
  return {
    ok: true,
    manifest: input,
    diversity: details.expectedDiversity,
    modeCounts: details.modeCounts,
  };
}

export function assertBenchmarkManifest(input) {
  const result = validateBenchmarkManifest(input);
  if (!result.ok) throw new TypeError(`Invalid benchmark manifest: ${result.errors.join('; ')}`);
  return result.manifest;
}

export function createBenchmarkReport(manifest, trialResults = [], safetyCases = []) {
  const validated = validateBenchmarkManifest(manifest);
  if (!validated.ok)
    throw new TypeError(`Invalid benchmark manifest: ${validated.errors.join('; ')}`);
  const resultErrors = [
    ...scanSecrets(trialResults, '$.results'),
    ...scanSecrets(safetyCases, '$.safety_cases'),
  ];
  if (!Array.isArray(trialResults)) resultErrors.push('$.results: must be an array');
  else if (trialResults.length !== 20)
    resultErrors.push('$.results: must contain exactly 20 trial results');
  if (!Array.isArray(safetyCases)) resultErrors.push('$.safety_cases: must be an array');
  else if (safetyCases.length !== SAFETY_CASES.size)
    resultErrors.push('$.safety_cases: must contain all three safety cases');

  const trialsById = new Map(manifest.trials.map((trial) => [trial.trial_id, trial]));
  const resultIds = new Set();
  if (Array.isArray(trialResults)) {
    for (const [index, result] of trialResults.entries()) {
      const path = `$.results[${index}]`;
      if (!isRecord(result)) {
        resultErrors.push(`${path}: expected a plain object`);
        continue;
      }
      checkKeys(result, RESULT_KEYS, path, resultErrors);
      const trial = trialsById.get(result.trial_id);
      if (!trial) resultErrors.push(`${path}: trial result does not match the manifest`);
      else {
        if (resultIds.has(result.trial_id)) resultErrors.push(`${path}.trial_id: must be unique`);
        resultIds.add(result.trial_id);
        if (result.mode !== trial.mode) resultErrors.push(`${path}.mode: does not match the trial`);
        if (result.guild_id !== trial.guild_id)
          resultErrors.push(`${path}.guild_id: does not match the trial`);
        if (
          result.activity_evidence !== null &&
          isRecord(result.activity_evidence) &&
          (result.activity_evidence.target?.guild_id !== trial.guild_id ||
            result.activity_evidence.target?.bot_id !== trial.expected_bot_id)
        ) {
          resultErrors.push(`${path}.activity_evidence.target: does not match the trial`);
        }
      }
      if (typeof result.eligible !== 'boolean')
        resultErrors.push(`${path}.eligible: must be boolean`);
      if (!TERMINAL_STATUSES.has(result.terminal_status))
        resultErrors.push(`${path}.terminal_status: is invalid`);
      if (typeof result.oracle_match !== 'boolean')
        resultErrors.push(`${path}.oracle_match: must be boolean`);
      for (const field of ['plan_id', 'blueprint_id']) {
        if (result[field] !== null && !DIGEST_RE.test(result[field] ?? ''))
          resultErrors.push(`${path}.${field}: must be a sha256 digest or null`);
      }
      for (const field of ['snapshot_oracle_pass', 'blueprint_oracle_match', 'audit_oracle_pass']) {
        if (typeof result[field] !== 'boolean') {
          resultErrors.push(`${path}.${field}: must be boolean`);
        }
      }
      if (!Array.isArray(result.serious_permission_failures))
        resultErrors.push(`${path}.serious_permission_failures: must be an array`);
      if (!validFailureArray(result.functional_failures))
        resultErrors.push(`${path}.functional_failures: must be an array`);
      if (typeof result.plan_snapshot_unchanged !== 'boolean')
        resultErrors.push(`${path}.plan_snapshot_unchanged: must be boolean`);
      for (const field of ['progressive_discovery_succeeded', 'dry_run_observed_before_apply']) {
        if (typeof result[field] !== 'boolean') {
          resultErrors.push(`${path}.${field}: must be boolean`);
        }
      }
      for (const field of ['apply_result_loss_observed', 'apply_result_loss_recovered']) {
        if (result[field] !== undefined && typeof result[field] !== 'boolean') {
          resultErrors.push(`${path}.${field}: must be boolean when present`);
        }
      }
      if (
        result.forced_resume_observed !== null &&
        typeof result.forced_resume_observed !== 'boolean'
      ) {
        resultErrors.push(`${path}.forced_resume_observed: must be boolean or null`);
      }
      for (const field of [
        'operations_planned',
        'apply_calls',
        'restart_count',
        'audit_entry_count',
      ]) {
        if (!nonnegativeInteger(result[field]))
          resultErrors.push(`${path}.${field}: must be a nonnegative integer`);
      }
      if (result.replay_status !== null && result.replay_status !== 'already_current')
        resultErrors.push(`${path}.replay_status: must be already_current or null`);
      if (
        result.evidence_status !== null &&
        !['verified', 'drifted', 'not_found', 'blocked'].includes(result.evidence_status)
      ) {
        resultErrors.push(`${path}.evidence_status: is invalid`);
      }
      if (typeof result.audit_trail_complete !== 'boolean')
        resultErrors.push(`${path}.audit_trail_complete: must be boolean`);
      if (result.verified_counts !== null && !validVerifiedCounts(result.verified_counts))
        resultErrors.push(`${path}.verified_counts: is invalid`);
      if (
        !Object.hasOwn(result, 'template_evidence') ||
        (result.template_evidence !== null && !validTemplateEvidence(result.template_evidence))
      )
        resultErrors.push(`${path}.template_evidence: is invalid`);
      if (
        !Object.hasOwn(result, 'activity_evidence') ||
        (result.activity_evidence !== null && !validActivityEvidence(result.activity_evidence))
      )
        resultErrors.push(`${path}.activity_evidence: is invalid`);
      if (
        isRecord(result.activity_evidence) &&
        (result.plan_id !== result.activity_evidence.plan_id ||
          result.blueprint_id !== result.activity_evidence.blueprint_id)
      ) {
        resultErrors.push(`${path}: plan/blueprint IDs do not match activity evidence`);
      }
      if (typeof result.baseline_verified_before !== 'boolean')
        resultErrors.push(`${path}.baseline_verified_before: must be boolean`);
      if (typeof result.baseline_restored_after !== 'boolean')
        resultErrors.push(`${path}.baseline_restored_after: must be boolean`);
      if (!DIGEST_RE.test(result.baseline_fingerprint_before ?? ''))
        resultErrors.push(`${path}.baseline_fingerprint_before: must be a sha256 digest`);
      if (!DIGEST_RE.test(result.baseline_fingerprint_after ?? ''))
        resultErrors.push(`${path}.baseline_fingerprint_after: must be a sha256 digest`);
      if (
        result.baseline_restore_attempts !== undefined &&
        !nonnegativeInteger(result.baseline_restore_attempts)
      ) {
        resultErrors.push(`${path}.baseline_restore_attempts: must be a nonnegative integer`);
      }
      if (
        validFailureArray(result.serious_permission_failures) &&
        validFailureArray(result.functional_failures) &&
        typeof result.eligible === 'boolean' &&
        typeof result.oracle_match === 'boolean' &&
        typeof result.snapshot_oracle_pass === 'boolean' &&
        typeof result.blueprint_oracle_match === 'boolean' &&
        typeof result.audit_oracle_pass === 'boolean' &&
        nonnegativeInteger(result.operations_planned) &&
        nonnegativeInteger(result.apply_calls) &&
        nonnegativeInteger(result.restart_count) &&
        nonnegativeInteger(result.audit_entry_count) &&
        (result.verified_counts === null || validVerifiedCounts(result.verified_counts)) &&
        typeof result.baseline_verified_before === 'boolean' &&
        typeof result.baseline_restored_after === 'boolean'
      ) {
        const derived = resultEvidencePass(result, trial);
        if (result.oracle_match !== derived)
          resultErrors.push(`${path}.oracle_match: disagrees with derived evidence`);
      }
    }
  }

  const observedSafetyCases = new Set();
  if (Array.isArray(safetyCases)) {
    for (const [index, safetyCase] of safetyCases.entries()) {
      const path = `$.safety_cases[${index}]`;
      if (!isRecord(safetyCase)) {
        resultErrors.push(`${path}: expected a plain object`);
        continue;
      }
      if (!SAFETY_CASES.has(safetyCase.case))
        resultErrors.push(`${path}.case: is not a required safety case`);
      else if (observedSafetyCases.has(safetyCase.case))
        resultErrors.push(`${path}.case: must be unique`);
      else observedSafetyCases.add(safetyCase.case);
      if (typeof safetyCase.passed !== 'boolean')
        resultErrors.push(`${path}.passed: must be boolean`);
      for (const field of [
        'guard_guild_id',
        'target_guild_id',
        'active_bot_id',
        'supplied_bot_id',
      ]) {
        if (!isSnowflake(safetyCase[field]))
          resultErrors.push(`${path}.${field}: must be a Discord snowflake`);
      }
      if (typeof safetyCase.blocked_before_discord !== 'boolean')
        resultErrors.push(`${path}.blocked_before_discord: must be boolean`);
      if (safetyCase.blocker_code !== null && typeof safetyCase.blocker_code !== 'string')
        resultErrors.push(`${path}.blocker_code: must be string or null`);
      if (!['ready', 'blocked'].includes(safetyCase.plan_status))
        resultErrors.push(`${path}.plan_status: must be ready or blocked`);
      if (!['passed', 'not_run'].includes(safetyCase.target_readback))
        resultErrors.push(`${path}.target_readback: must be passed or not_run`);
      for (const field of ['operations_planned', 'audit_entry_count', 'mutation_count']) {
        if (!nonnegativeInteger(safetyCase[field]))
          resultErrors.push(`${path}.${field}: must be a nonnegative integer`);
      }
      if (typeof safetyCase.snapshot_unchanged !== 'boolean')
        resultErrors.push(`${path}.snapshot_unchanged: must be boolean`);
      if (
        typeof safetyCase.passed === 'boolean' &&
        safetyCase.passed !== safetyEvidencePass(safetyCase)
      ) {
        resultErrors.push(`${path}.passed: disagrees with derived evidence`);
      }
    }
    if (
      observedSafetyCases.size !== SAFETY_CASES.size ||
      [...SAFETY_CASES].some((name) => !observedSafetyCases.has(name))
    ) {
      resultErrors.push('$.safety_cases: must contain wrong_bot, wrong_guild, and write_preview');
    }
  }
  if (resultErrors.length > 0)
    throw new TypeError(`Invalid benchmark report data: ${resultErrors.join('; ')}`);

  const eligible = trialResults.filter((result) => result.eligible).length;
  const completed = trialResults.filter((result) => {
    const trial = trialsById.get(result.trial_id);
    return resultEvidencePass(result, trial ?? null);
  }).length;
  const seriousPermissionFailures = trialResults.reduce(
    (count, result) => count + result.serious_permission_failures.length,
    0,
  );
  const safetyCasesPassed = safetyCases.every((safetyCase) => safetyCase.passed);
  const applyResultLossCases = trialResults.filter(
    (result) => result.apply_result_loss_observed === true,
  ).length;
  const applyResultLossRecoveries = trialResults.filter(
    (result) =>
      result.apply_result_loss_observed === true && result.apply_result_loss_recovered === true,
  ).length;
  const verifiedCorrectnessGatePassed =
    eligible === 20 &&
    completed === 20 &&
    seriousPermissionFailures === 0 &&
    safetyCasesPassed &&
    applyResultLossCases > 0 &&
    applyResultLossCases === applyResultLossRecoveries &&
    trialResults.every(applyResultLossEvidencePass);

  return {
    schema_version: REPORT_SCHEMA,
    manifest_schema_version: BENCHMARK_SCHEMA,
    run_id: manifest.run_id,
    commit: manifest.commit,
    not_before: manifest.not_before,
    started_at: manifest.started_at,
    request: manifest.request,
    built_cli: cloneJson(manifest.built_cli),
    api_version: manifest.api_version,
    trial_count: trialResults.length,
    mode_counts: { ...validated.modeCounts },
    reuse_policy: cloneJson(manifest.reuse_policy),
    guild_diversity: cloneJson(validated.diversity),
    results: cloneJson(trialResults),
    safety_cases: cloneJson(safetyCases),
    summary: {
      eligible,
      completed,
      success_rate: eligible === 0 ? 0 : completed / eligible,
      serious_permission_failures: seriousPermissionFailures,
      safety_cases_passed: safetyCasesPassed,
      apply_result_loss_cases: applyResultLossCases,
      apply_result_loss_recoveries: applyResultLossRecoveries,
      gate_passed:
        eligible === 20 && completed >= 19 && seriousPermissionFailures === 0 && safetyCasesPassed,
      verified_correctness_gate_passed: verifiedCorrectnessGatePassed,
    },
  };
}
