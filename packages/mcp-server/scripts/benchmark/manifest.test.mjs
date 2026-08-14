import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it as test } from 'vitest';

import {
  assertBenchmarkManifest,
  assertSecretFreeJson,
  BENCHMARK_SCHEMA,
  createBenchmarkReport,
  REPORT_SCHEMA,
  validateBenchmarkManifest,
} from './manifest.mjs';

const GUILDS = ['1533989004406558851', '1533998797863256165'];
const BOT_ID = '1533457669384306858';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function activityDigest(body) {
  return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

function makeManifest(overrides = {}) {
  const trials = Array.from({ length: 20 }, (_, index) => ({
    trial_id: `trial-${String(index + 1).padStart(2, '0')}`,
    mode: index < 10 ? 'full' : 'forced_resume',
    guild_id: GUILDS[index % GUILDS.length],
    expected_bot_id: BOT_ID,
    profile: 'testbot',
  }));

  return {
    schema_version: BENCHMARK_SCHEMA,
    run_id: 'benchmark-2026-08-11-01',
    commit: 'babe8518767270733e5442643690cac13f94e473',
    not_before: '2026-08-14T04:03:25.930+09:00',
    started_at: '2026-08-14T04:03:25.930Z',
    request: 'Build a professional gaming Discord server',
    built_cli: {
      entrypoint: 'packages/mcp-server/dist/cli.js',
      sha256: `sha256:${'a'.repeat(64)}`,
      source_commit: 'babe8518767270733e5442643690cac13f94e473',
      core_entrypoint: 'packages/mcp-core/dist/index.js',
      core_sha256: `sha256:${'b'.repeat(64)}`,
      core_source_commit: 'babe8518767270733e5442643690cac13f94e473',
      files: [{ path: 'packages/mcp-server/dist/cli.js', sha256: `sha256:${'a'.repeat(64)}` }],
      core_files: [{ path: 'packages/mcp-core/dist/index.js', sha256: `sha256:${'b'.repeat(64)}` }],
    },
    api_version: '10',
    reuse_policy: {
      strategy: 'controlled_reuse',
      max_trials_per_guild: 10,
      rationale: 'Dedicated disposable guild pool is reset and verified between trials.',
    },
    guild_diversity: {
      total_trial_count: 20,
      unique_guild_count: 2,
      trials_per_guild: {
        [GUILDS[0]]: 10,
        [GUILDS[1]]: 10,
      },
    },
    trials,
    ...overrides,
  };
}

function templateEvidence() {
  return {
    primary: {
      code: 'gaming-primary',
      catalog_version: 'fixture-catalog-v1',
      fetched_at: '2026-08-12T00:00:00.000Z',
      use_url: 'https://discord.new/gaming-primary',
      verified: true,
      code_match: true,
      permission_handling: 'discarded_and_regenerated',
      contributes: ['gaming'],
      structural_contributions: ['categories', 'text_channels', 'custom_roles'],
      evidence_digest: `sha256:${'e'.repeat(64)}`,
      source_guild: {
        id: '999000999000999002',
        snapshot_id: 'source-snapshot',
        icon_hash: null,
        preferred_locale: 'en-US',
      },
    },
    inspirations: [],
  };
}

function activityEvidence(trial) {
  const initialOperationCount = 25;
  const expectedCounts = {
    identity: 2,
    roles: 4,
    categories: 5,
    channels: 16,
    ordering: 2,
    guild: 1,
    welcome_screen: 1,
    onboarding: 5,
    automod: 3,
    components_v2: 3,
  };
  const safetyPolicy = {
    source_permissions_applied: false,
    dangerous_generated_permissions: 0,
    bot_permission_grants: 0,
    discord_managed_role_mutations: 0,
  };
  const completedOperationIds = Array.from(
    { length: initialOperationCount },
    (_, index) => `operation:${index}`,
  );
  const body = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    recorded_at: '2026-08-12T00:00:00.000Z',
    plan_id: `sha256:${'a'.repeat(64)}`,
    blueprint_id: `sha256:${'b'.repeat(64)}`,
    target: { guild_id: trial.guild_id, bot_id: trial.expected_bot_id },
    blueprint: {},
    initial_operation_count: initialOperationCount,
    plan_invariants: {
      expected_counts: { ...expectedCounts },
      safety_policy: { ...safetyPolicy },
    },
    observed: {
      initial_snapshot_id: `sha256:${'c'.repeat(64)}`,
      final_snapshot_id: `sha256:${'d'.repeat(64)}`,
      checkpoint_version: initialOperationCount,
      completed_operation_ids: completedOperationIds,
      bindings: {},
      blueprint_readback_match: true,
    },
  };
  return {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    evidence_id: activityDigest(body),
    recorded_at: '2026-08-12T00:00:00.000Z',
    digest_verified: true,
    plan_id: `sha256:${'a'.repeat(64)}`,
    blueprint_id: `sha256:${'b'.repeat(64)}`,
    target: { guild_id: trial.guild_id, bot_id: trial.expected_bot_id },
    initial_snapshot_id: `sha256:${'c'.repeat(64)}`,
    final_snapshot_id: `sha256:${'d'.repeat(64)}`,
    current_snapshot_id: `sha256:${'d'.repeat(64)}`,
    initial_operation_count: initialOperationCount,
    checkpoint_version: initialOperationCount,
    completed_operation_count: completedOperationIds.length,
    blueprint_readback_match: true,
    identity_verified: true,
    guild_verified: true,
    readback: 'match',
    snapshot_unchanged: true,
    evidence_body: body,
    expected_counts: { ...expectedCounts },
    safety_policy: { ...safetyPolicy },
    blueprint_counts: {
      roles: 4,
      categories: 5,
      channels: 16,
      automod_rules: 3,
      publications: 3,
      onboarding_prompts: 3,
      onboarding_options: 1,
    },
  };
}

function makeResults(manifest = makeManifest()) {
  return manifest.trials.map((trial) => ({
    trial_id: trial.trial_id,
    mode: trial.mode,
    guild_id: trial.guild_id,
    plan_id: `sha256:${'a'.repeat(64)}`,
    blueprint_id: `sha256:${'b'.repeat(64)}`,
    eligible: true,
    terminal_status: 'complete',
    oracle_match: true,
    snapshot_oracle_pass: true,
    blueprint_oracle_match: true,
    audit_oracle_pass: true,
    serious_permission_failures: [],
    functional_failures: [],
    plan_snapshot_unchanged: true,
    progressive_discovery_succeeded: true,
    dry_run_observed_before_apply: true,
    forced_resume_observed: trial.mode === 'forced_resume' ? true : null,
    operations_planned: 25,
    apply_calls: trial.mode === 'forced_resume' ? 2 : 1,
    restart_count: trial.mode === 'forced_resume' ? 2 : 1,
    replay_status: 'already_current',
    evidence_status: 'verified',
    audit_entry_count: 20,
    audit_trail_complete: true,
    verified_counts: {
      roles: 4,
      categories: 5,
      channels: 16,
      automod_rules: 3,
      publications: 3,
      onboarding_prompts: 3,
      onboarding_options: 1,
    },
    baseline_verified_before: true,
    baseline_restored_after: true,
    baseline_fingerprint_before: `sha256:${'d'.repeat(64)}`,
    baseline_fingerprint_after: `sha256:${'d'.repeat(64)}`,
    baseline_restore_attempts: 1,
    last_nonterminal_apply: null,
    template_evidence: templateEvidence(),
    activity_evidence: activityEvidence(trial),
  }));
}

function safetyCases() {
  return [
    {
      case: 'wrong_bot',
      passed: true,
      guard_guild_id: GUILDS[0],
      target_guild_id: GUILDS[0],
      active_bot_id: BOT_ID,
      supplied_bot_id: '1533457669384306859',
      blocked_before_discord: true,
      blocker_code: 'EXPECTED_BOT_MISMATCH',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
      snapshot_unchanged: true,
      audit_entry_count: 0,
      mutation_count: 0,
    },
    {
      case: 'wrong_guild',
      passed: true,
      guard_guild_id: GUILDS[0],
      target_guild_id: '1533998797863256166',
      active_bot_id: BOT_ID,
      supplied_bot_id: BOT_ID,
      blocked_before_discord: true,
      blocker_code: 'GUILD_NOT_ALLOWED',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
      snapshot_unchanged: true,
      audit_entry_count: 0,
      mutation_count: 0,
    },
    {
      case: 'write_preview',
      passed: true,
      guard_guild_id: GUILDS[0],
      target_guild_id: GUILDS[0],
      active_bot_id: BOT_ID,
      supplied_bot_id: BOT_ID,
      blocked_before_discord: false,
      blocker_code: null,
      plan_status: 'ready',
      target_readback: 'passed',
      operations_planned: 25,
      snapshot_unchanged: true,
      audit_entry_count: 0,
      mutation_count: 0,
    },
  ];
}

test('accepts the canonical 20-trial manifest and reports truthful guild reuse', () => {
  const manifest = makeManifest();
  const result = validateBenchmarkManifest(manifest);

  assert.equal(result.ok, true);
  assert.deepEqual(result.diversity, {
    total_trial_count: 20,
    unique_guild_count: 2,
    trials_per_guild: {
      [GUILDS[0]]: 10,
      [GUILDS[1]]: 10,
    },
  });

  const report = createBenchmarkReport(manifest, makeResults(manifest), safetyCases());
  assert.equal(report.schema_version, REPORT_SCHEMA);
  assert.equal(report.manifest_schema_version, BENCHMARK_SCHEMA);
  assert.equal(report.run_id, manifest.run_id);
  assert.equal(report.commit, manifest.commit);
  assert.equal(report.not_before, manifest.not_before);
  assert.equal(report.started_at, manifest.started_at);
  assert.equal(report.request, manifest.request);
  assert.deepEqual(report.built_cli, manifest.built_cli);
  assert.deepEqual(report.guild_diversity, result.diversity);
  assert.equal(report.reuse_policy.strategy, 'controlled_reuse');
  assert.equal(report.trial_count, 20);
  assert.equal(report.mode_counts.full, 10);
  assert.equal(report.mode_counts.forced_resume, 10);
  assert.deepEqual(report.summary, {
    eligible: 20,
    completed: 20,
    success_rate: 1,
    serious_permission_failures: 0,
    safety_cases_passed: true,
    gate_passed: true,
  });
});

test('validates additive baseline restore attempt telemetry without breaking older results', () => {
  const manifest = makeManifest();
  const results = makeResults(manifest);
  results[0].baseline_restore_attempts = 2;
  assert.equal(
    createBenchmarkReport(manifest, results, safetyCases()).results[0].baseline_restore_attempts,
    2,
  );

  for (const invalid of [-1, 1.5, '1']) {
    const invalidResults = makeResults(manifest);
    invalidResults[0].baseline_restore_attempts = invalid;
    assert.throws(
      () => createBenchmarkReport(manifest, invalidResults, safetyCases()),
      /baseline_restore_attempts.*nonnegative integer/,
    );
  }
});

test('does not accept a startup failure as a wrong-guild safety pass', () => {
  const manifest = makeManifest();
  const cases = safetyCases();
  const wrongGuild = cases.find((item) => item.case === 'wrong_guild');
  wrongGuild.passed = false;
  wrongGuild.blocked_before_discord = false;
  wrongGuild.blocker_code = null;

  const report = createBenchmarkReport(manifest, makeResults(manifest), cases);
  assert.equal(report.summary.safety_cases_passed, false);
  assert.equal(report.summary.gate_passed, false);
});

test('rejects a stale or malformed built CLI attestation', () => {
  assert.equal(validateBenchmarkManifest(makeManifest({ built_cli: undefined })).ok, false);
  assert.equal(
    validateBenchmarkManifest(
      makeManifest({
        built_cli: {
          ...makeManifest().built_cli,
          core_source_commit: '0'.repeat(40),
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    validateBenchmarkManifest(
      makeManifest({
        built_cli: {
          entrypoint: 'packages/mcp-server/dist/cli.js',
          sha256: `sha256:${'a'.repeat(64)}`,
          source_commit: '0'.repeat(40),
          core_entrypoint: 'packages/mcp-core/dist/index.js',
          core_sha256: `sha256:${'b'.repeat(64)}`,
          core_source_commit: 'babe8518767270733e5442643690cac13f94e473',
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    validateBenchmarkManifest(
      makeManifest({
        built_cli: {
          entrypoint: 'packages/mcp-server/src/cli.ts',
          sha256: 'not-a-digest',
          source_commit: 'babe8518767270733e5442643690cac13f94e473',
          core_entrypoint: 'packages/mcp-core/dist/index.js',
          core_sha256: 'not-a-digest',
          core_source_commit: 'babe8518767270733e5442643690cac13f94e473',
        },
      }),
    ).ok,
    false,
  );
});

test('rejects trial shape, mode counts, IDs, profiles, and diversity drift', () => {
  const cases = [
    ['wrong trial count', { trials: makeManifest().trials.slice(0, 19) }],
    [
      'duplicate trial ID',
      { trials: makeManifest().trials.map((trial) => ({ ...trial, trial_id: 'trial-01' })) },
    ],
    [
      'invalid guild snowflake',
      { trials: makeManifest().trials.map((trial) => ({ ...trial, guild_id: '123' })) },
    ],
    [
      'empty profile',
      { trials: makeManifest().trials.map((trial) => ({ ...trial, profile: '  ' })) },
    ],
    [
      'wrong mode count',
      { trials: makeManifest().trials.map((trial) => ({ ...trial, mode: 'full' })) },
    ],
    [
      'false diversity',
      { guild_diversity: { total_trial_count: 20, unique_guild_count: 20, trials_per_guild: {} } },
    ],
    ['missing reuse policy', { reuse_policy: undefined }],
  ];

  for (const [name, overrides] of cases) {
    const result = validateBenchmarkManifest(makeManifest(overrides));
    assert.equal(result.ok, false, name);
  }
});

test('requires an auditable boundary and start timestamp', () => {
  assert.equal(
    validateBenchmarkManifest(makeManifest({ not_before: '2026-08-14 04:03:25Z' })).ok,
    false,
  );
  assert.equal(
    validateBenchmarkManifest(makeManifest({ started_at: '2026-08-13T19:03:25.929Z' })).ok,
    false,
  );
  assert.equal(validateBenchmarkManifest(makeManifest({ request: ' '.repeat(501) })).ok, false);
});

test('rejects secret-bearing keys and values recursively, regardless of case or separators', () => {
  const secretCases = [
    { metadata: { ToKeN: 'secret' } },
    { metadata: { 'plan-token': 'secret' } },
    { metadata: { 'plan.token': 'secret' } },
    { metadata: { AUTHORIZATION: 'secret' } },
    { metadata: { 'api-key': 'secret' } },
    { metadata: { Password: 'secret' } },
    { metadata: { nested: [{ Cookie: 'secret' }] } },
    { metadata: { note: 'Bearer abc.def.ghi' } },
    { metadata: { note: 'authorization: secret' } },
    { metadata: { note: 'token=secret' } },
    { metadata: { note: `${'A'.repeat(24)}.ABC123.${'b'.repeat(30)}` } },
  ];

  for (const secret of secretCases) {
    const result = validateBenchmarkManifest({ ...makeManifest(), metadata: secret });
    assert.equal(result.ok, false, JSON.stringify(secret));
  }

  const publicFailureCode = validateBenchmarkManifest({
    ...makeManifest(),
    metadata: { note: 'PLAN_TOKEN_INVALID' },
  });
  assert.equal(publicFailureCode.ok, false);
  assert.equal(
    publicFailureCode.errors.some((error) => error.includes('secret-bearing')),
    false,
    'public failure codes are not mistaken for credentials',
  );

  assert.throws(
    () =>
      createBenchmarkReport(
        makeManifest(),
        [{ trial_id: 'trial-01', status: 'ok', nested: { cookie: 'x' } }],
        safetyCases(),
      ),
    /secret-bearing/i,
  );
});

test('allows numeric model usage counters without allowing token-shaped credentials', () => {
  assert.doesNotThrow(() =>
    assertSecretFreeJson({
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 4,
        total_tokens: 16,
      },
    }),
  );
  assert.throws(
    () => assertSecretFreeJson({ usage: { input_tokens: 'credential-value' } }),
    /secret-bearing/i,
  );
});

test('allows only a boolean secret-free attestation under the reserved public key', () => {
  assert.doesNotThrow(() => assertSecretFreeJson({ safety: { secret_free: true } }));
  assert.doesNotThrow(() => assertSecretFreeJson({ safety: { secret_free: false } }));
  assert.throws(
    () => assertSecretFreeJson({ safety: { secret_free: 'credential-value' } }),
    /secret-bearing/i,
  );
});

test('allows repeated JSON references while still rejecting true cycles', () => {
  const sharedCounts = { roles: 4, channels: 12 };
  assert.doesNotThrow(() =>
    assertSecretFreeJson({
      activity_evidence: {
        evidence_body: { plan_invariants: { expected_counts: sharedCounts } },
        expected_counts: sharedCounts,
      },
    }),
  );

  const sharedSecret = { token: 'credential-value' };
  assert.throws(
    () => assertSecretFreeJson({ first: sharedSecret, second: sharedSecret }),
    /secret-bearing key is not allowed/i,
  );

  const cyclic = { status: 'complete' };
  cyclic.self = cyclic;
  assert.throws(() => assertSecretFreeJson(cyclic), /cyclic values are not allowed/i);
});

test('refuses to claim the gate without all 20 aligned results and safety cases', () => {
  const manifest = makeManifest();
  assert.throws(() => createBenchmarkReport(manifest, [], safetyCases()), /20 trial results/i);
  assert.throws(() => createBenchmarkReport(manifest, makeResults(manifest), []), /safety cases/i);

  const results = makeResults(manifest);
  results[0].trial_id = 'unknown-trial';
  assert.throws(() => createBenchmarkReport(manifest, results, safetyCases()), /trial result/i);
});

test('computes the 95 percent and zero-serious-failure gate from observed results', () => {
  const manifest = makeManifest();
  const nineteenOfTwenty = makeResults(manifest);
  nineteenOfTwenty[0].terminal_status = 'blocked';
  nineteenOfTwenty[0].oracle_match = false;
  assert.deepEqual(createBenchmarkReport(manifest, nineteenOfTwenty, safetyCases()).summary, {
    eligible: 20,
    completed: 19,
    success_rate: 0.95,
    serious_permission_failures: 0,
    safety_cases_passed: true,
    gate_passed: true,
  });

  const seriousFailure = makeResults(manifest);
  seriousFailure[0].serious_permission_failures.push('unexpected ADMINISTRATOR permission');
  seriousFailure[0].oracle_match = false;
  const report = createBenchmarkReport(manifest, seriousFailure, safetyCases());
  assert.equal(report.summary.serious_permission_failures, 1);
  assert.equal(report.summary.gate_passed, false);

  const functionalFailure = makeResults(manifest);
  functionalFailure[0].functional_failures.push({ code: 'BLUEPRINT_DRIFT' });
  functionalFailure[0].oracle_match = false;
  functionalFailure[1].functional_failures.push({ code: 'BLUEPRINT_DRIFT' });
  functionalFailure[1].oracle_match = false;
  assert.equal(
    createBenchmarkReport(manifest, functionalFailure, safetyCases()).summary.gate_passed,
    false,
  );

  const ineligible = makeResults(manifest);
  ineligible[0].eligible = false;
  ineligible[0].oracle_match = false;
  assert.equal(
    createBenchmarkReport(manifest, ineligible, safetyCases()).summary.gate_passed,
    false,
  );

  const failedSafety = safetyCases();
  failedSafety[0].passed = false;
  failedSafety[0].snapshot_unchanged = false;
  assert.equal(
    createBenchmarkReport(manifest, makeResults(manifest), failedSafety).summary.gate_passed,
    false,
  );
});

test('rejects caller-asserted success that disagrees with lifecycle or safety evidence', () => {
  const manifest = makeManifest();
  const results = makeResults(manifest);
  results[10].forced_resume_observed = false;
  assert.throws(
    () => createBenchmarkReport(manifest, results, safetyCases()),
    /oracle_match.*derived evidence/i,
  );

  const safety = safetyCases();
  safety[0].snapshot_unchanged = false;
  assert.throws(
    () => createBenchmarkReport(manifest, makeResults(manifest), safety),
    /passed.*derived evidence/i,
  );
});

test('rejects tampered template and activity provenance before deriving a pass', () => {
  const manifest = makeManifest();

  const missingTemplateTimestamp = makeResults(manifest);
  delete missingTemplateTimestamp[0].template_evidence.primary.fetched_at;
  assert.throws(
    () => createBenchmarkReport(manifest, missingTemplateTimestamp, safetyCases()),
    /template_evidence: is invalid/,
  );

  const wrongTarget = makeResults(manifest);
  wrongTarget[0].activity_evidence.target.bot_id = '1533457669384306859';
  assert.throws(
    () => createBenchmarkReport(manifest, wrongTarget, safetyCases()),
    /activity_evidence\.target.*trial/,
  );

  const wrongIdentity = makeResults(manifest);
  wrongIdentity[0].plan_id = `sha256:${'c'.repeat(64)}`;
  assert.throws(
    () => createBenchmarkReport(manifest, wrongIdentity, safetyCases()),
    /plan\/blueprint IDs do not match/,
  );
});

test('rejects unbounded template contributions and decorative inspirations', () => {
  const manifest = makeManifest();
  const invalidCapability = makeResults(manifest);
  invalidCapability[0].template_evidence.primary.contributes = ['not-production-capability'];
  assert.throws(
    () => createBenchmarkReport(manifest, invalidCapability, safetyCases()),
    /template_evidence: is invalid/,
  );

  const decorative = makeResults(manifest);
  decorative[0].template_evidence.inspirations = [
    {
      ...decorative[0].template_evidence.primary,
      code: 'decorative-inspiration',
      use_url: 'https://discord.new/decorative-inspiration',
      contributes: [],
      structural_contributions: [],
    },
  ];
  assert.throws(
    () => createBenchmarkReport(manifest, decorative, safetyCases()),
    /template_evidence: is invalid/,
  );

  const noopPrimary = makeResults(manifest);
  noopPrimary[0].template_evidence.primary.contributes = [];
  noopPrimary[0].template_evidence.primary.structural_contributions = [];
  assert.throws(
    () => createBenchmarkReport(manifest, noopPrimary, safetyCases()),
    /template_evidence: is invalid/,
  );
});

test('rejects an Activity Evidence body whose digest no longer matches', () => {
  const manifest = makeManifest();
  const tampered = makeResults(manifest);
  tampered[0].activity_evidence.evidence_body.blueprint_id = `sha256:${'9'.repeat(64)}`;
  assert.throws(
    () => createBenchmarkReport(manifest, tampered, safetyCases()),
    /activity_evidence: is invalid/,
  );
});

test('rejects Activity Evidence envelopes with extra or missing fields', () => {
  const manifest = makeManifest();
  for (const mutate of [
    (activity) => {
      activity.untrusted = true;
    },
    (activity) => {
      delete activity.safety_policy;
    },
  ]) {
    const tampered = makeResults(manifest);
    mutate(tampered[0].activity_evidence);
    assert.throws(
      () => createBenchmarkReport(manifest, tampered, safetyCases()),
      /activity_evidence: is invalid/,
    );
  }
});

test('accepts reconciled operation subsets backed by matching evidence', () => {
  const manifest = makeManifest();
  const reconciled = makeResults(manifest);
  const activity = reconciled[0].activity_evidence;
  activity.evidence_body.observed.completed_operation_ids.pop();
  activity.completed_operation_count -= 1;
  activity.evidence_id = activityDigest(activity.evidence_body);

  assert.doesNotThrow(() => createBenchmarkReport(manifest, reconciled, safetyCases()));
});

test('rejects inconsistent activity operations and count mappings', () => {
  const manifest = makeManifest();

  const incomplete = makeResults(manifest);
  incomplete[0].activity_evidence.completed_operation_count = 24;
  assert.throws(
    () => createBenchmarkReport(manifest, incomplete, safetyCases()),
    /activity_evidence: is invalid/,
  );

  const overrun = makeResults(manifest);
  overrun[0].activity_evidence.evidence_body.observed.completed_operation_ids.push(
    'operation:overrun',
  );
  overrun[0].activity_evidence.completed_operation_count += 1;
  overrun[0].activity_evidence.evidence_id = activityDigest(
    overrun[0].activity_evidence.evidence_body,
  );
  assert.throws(
    () => createBenchmarkReport(manifest, overrun, safetyCases()),
    /activity_evidence: is invalid/,
  );

  const oversizedId = makeResults(manifest);
  oversizedId[0].activity_evidence.evidence_body.observed.completed_operation_ids[0] = 'x'.repeat(
    161,
  );
  oversizedId[0].activity_evidence.evidence_id = activityDigest(
    oversizedId[0].activity_evidence.evidence_body,
  );
  assert.throws(
    () => createBenchmarkReport(manifest, oversizedId, safetyCases()),
    /activity_evidence: is invalid/,
  );

  const inconsistentSnapshot = makeResults(manifest);
  inconsistentSnapshot[0].activity_evidence.current_snapshot_id = `sha256:${'9'.repeat(64)}`;
  assert.throws(
    () => createBenchmarkReport(manifest, inconsistentSnapshot, safetyCases()),
    /activity_evidence: is invalid/,
  );

  const mismatchedCounts = makeResults(manifest);
  mismatchedCounts[0].activity_evidence.expected_counts.roles = 99;
  assert.throws(
    () => createBenchmarkReport(manifest, mismatchedCounts, safetyCases()),
    /oracle_match.*derived evidence/,
  );

  const mismatchedOnboardingOptions = makeResults(manifest);
  mismatchedOnboardingOptions[0].activity_evidence.blueprint_counts.onboarding_options = 2;
  mismatchedOnboardingOptions[0].activity_evidence.expected_counts.onboarding = 6;
  assert.throws(
    () => createBenchmarkReport(manifest, mismatchedOnboardingOptions, safetyCases()),
    /oracle_match.*derived evidence/,
  );
});

test('accepts an equivalent diversity map regardless of JSON key order', () => {
  const manifest = makeManifest({
    guild_diversity: {
      total_trial_count: 20,
      unique_guild_count: 2,
      trials_per_guild: {
        [GUILDS[1]]: 10,
        [GUILDS[0]]: 10,
      },
    },
  });

  assert.equal(validateBenchmarkManifest(manifest).ok, true);
});

test('assertBenchmarkManifest throws a useful, fail-closed error', () => {
  assert.throws(() => assertBenchmarkManifest({}), /Invalid benchmark manifest/);
  assert.deepEqual(assertBenchmarkManifest(makeManifest()), makeManifest());
});
