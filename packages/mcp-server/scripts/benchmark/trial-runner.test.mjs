import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { activityEvidenceDigest, publicationTargets, runBenchmarkTrial } from './trial-runner.mjs';

const GUILD_ID = '999000999000999000';
const BOT_ID = '888000888000888000';
const CHANNEL_ID = '777000777000777000';
const MESSAGE_ID = '666000666000666000';
const BASELINE_CHANNEL_ID = '775000775000775000';
const GENERATED_CHANNEL_ID = '774000774000774000';
const GENERATED_MESSAGE_ID = '665000665000665000';
const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const BLUEPRINT_ID = `sha256:${'b'.repeat(64)}`;
const APPROVAL_ID = `sha256:${'c'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'e'.repeat(64)}`;
const TEMPLATE_DIGEST = `sha256:${'f'.repeat(64)}`;

function trial(mode = 'full') {
  return {
    trial_id: `trial-${mode}`,
    mode,
    guild_id: GUILD_ID,
    expected_bot_id: BOT_ID,
    profile: 'testbot',
  };
}

function plan() {
  return {
    status: 'ready',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    blueprint_id: BLUEPRINT_ID,
    snapshot_id: SNAPSHOT_ID,
    source: {
      catalog_version: 'fixture-catalog-v1',
      primary: {
        code: 'gaming-primary',
        catalog_version: 'fixture-catalog-v1',
        use_url: 'https://discord.new/gaming-primary',
        quality: {
          verified: true,
          code_match: true,
          permission_handling: 'discarded_and_regenerated',
        },
        contributes: ['gaming'],
        structural_contributions: ['categories', 'text_channels', 'custom_roles'],
        provenance: {
          evidence_digest: TEMPLATE_DIGEST,
          fetched_at: '2026-08-12T00:00:00.000Z',
          source_guild: {
            id: '999000999000999002',
            snapshot_id: 'source-snapshot',
            icon_hash: null,
            preferred_locale: 'en-US',
          },
        },
      },
      inspirations: [],
      permission_policy: 'discard_source_and_regenerate',
    },
    blueprint: {
      roles: [{ key: 'member' }],
      categories: [{ key: 'community' }],
      channels: [{ key: 'general' }],
      onboarding: { prompts: [{ key: 'platform', options: [{ key: 'pc' }] }] },
      automod: { rules: [{ key: 'spam' }] },
      components_v2: {
        publications: [{ key: 'welcome', channel_key: 'general' }],
      },
    },
    plan_id: PLAN_ID,
    approval_id: APPROVAL_ID,
    plan_token: 'opaque-plan-token-kept-in-memory',
    operations: [
      { operation_id: 'channel:create:general' },
      { operation_id: 'publication:welcome' },
    ],
    blockers: [],
    warnings: ['No Discord resource was changed; this is an exact target-bound dry-run.'],
  };
}

function bindings(channelId = CHANNEL_ID, messageId = MESSAGE_ID) {
  return {
    roles: { member: '771000771000771000' },
    categories: { community: '772000772000772000' },
    channels: { general: channelId },
    automod_rules: { spam: '773000773000773000' },
    publications: { welcome: messageId },
  };
}

function activity(
  channelId = CHANNEL_ID,
  messageId = MESSAGE_ID,
  activityBindings = bindings(channelId, messageId),
  completedOperationIds = ['channel:create:general', 'publication:welcome'],
  initialOperationCount = completedOperationIds.length,
) {
  const record = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    recorded_at: '2026-08-12T00:00:00.000Z',
    initial_operation_count: initialOperationCount,
    plan_invariants: {
      expected_counts: {
        identity: 2,
        roles: 1,
        categories: 1,
        channels: 1,
        ordering: 2,
        guild: 1,
        welcome_screen: 1,
        onboarding: 3,
        automod: 1,
        components_v2: 1,
      },
      blueprint_counts: {
        roles: 1,
        categories: 1,
        channels: 1,
        automod_rules: 1,
        publications: 1,
        onboarding_prompts: 1,
        onboarding_options: 1,
      },
      safety_policy: {
        source_permissions_applied: false,
        dangerous_generated_permissions: 0,
        bot_permission_grants: 0,
        discord_managed_role_mutations: 0,
      },
    },
    observed: {
      initial_snapshot_id: SNAPSHOT_ID,
      final_snapshot_id: SNAPSHOT_ID,
      checkpoint_version: 1,
      completed_operation_ids: completedOperationIds,
      bindings: activityBindings,
      blueprint_readback_match: true,
    },
  };
  const digestPlan = plan();
  digestPlan.operations = Array.from({ length: initialOperationCount }, (_, index) => ({
    operation_id: `fixture:${index}`,
  }));
  return { ...record, evidence_id: activityEvidenceDigest(digestPlan, record) };
}

function applyResult(
  status,
  attempted,
  remaining,
  channelId = CHANNEL_ID,
  messageId = MESSAGE_ID,
  overrides = {},
) {
  const operationIds = ['channel:create:general', 'publication:welcome'];
  return {
    status,
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    progress: {
      initial_planned: 2,
      planned_this_call: attempted,
      attempted_this_call: attempted,
      completed_total:
        status === 'partial' ? 1 : status === 'complete' || status === 'already_current' ? 2 : 0,
      remaining,
      checkpoint_version:
        status === 'blocked' || status === 'busy' || status === 'stale'
          ? null
          : status === 'already_current'
            ? 2
            : 1,
    },
    attempts: Array.from({ length: attempted }, (_, index) => ({
      operation_id: operationIds[index],
      status: 'completed',
      resource_id: channelId,
      error_code: null,
    })),
    blockers: [],
    error: null,
    evidence: {
      identity_verified: true,
      guild_verified: true,
      readback: status === 'complete' || status === 'already_current' ? 'match' : 'not_run',
      bindings: bindings(channelId, messageId),
      completed_operation_ids: operationIds.slice(0, status === 'partial' ? 1 : 2),
      activity:
        status === 'complete' || status === 'already_current'
          ? activity(
              channelId,
              messageId,
              overrides.completeBindingsOverride ?? bindings(channelId, messageId),
              overrides.completeCompletedOperationIds ?? operationIds,
            )
          : null,
    },
    next_action:
      status === 'complete' || status === 'already_current'
        ? 'done'
        : status === 'stale'
          ? 'replan'
          : 'resume',
    ...overrides,
  };
}

function evidence() {
  const record = activity();
  return {
    status: 'verified',
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    evidence_id: activityEvidenceDigest(plan(), record),
    record,
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      snapshot_unchanged: true,
      current_snapshot: {
        snapshot_id: SNAPSHOT_ID,
        guild: { id: GUILD_ID, name: 'fixture', features: [] },
        bot_id: BOT_ID,
        resources: { roles: 0, categories: 0, channels: 1, automod_rules: 0, recent_messages: 0 },
        onboarding_enabled: false,
        welcome_screen_configured: false,
      },
      remaining_operations: [],
      blockers: [],
      warnings: [],
    },
  };
}

function checkpoint(overrides = {}) {
  return {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    version: 2,
    status: 'partial',
    bindings: bindings(),
    completed_operation_ids: ['channel:create:general', 'publication:welcome'],
    last_error: null,
    ...overrides,
  };
}

function harness(
  mode,
  {
    planFingerprint = 'baseline',
    evidenceResult = evidence(),
    baselineChannel = false,
    baselineChannelIds = [],
    generatedChannelId = CHANNEL_ID,
    generatedMessageId = MESSAGE_ID,
    failResume = false,
    closeFailure = false,
    planCallFailures = 0,
    applyTransportFailures = 0,
    retriableApplyResponses = 0,
    retriableApplyRetryAfterMs,
    retriableVerificationResponses = 0,
    retriableForcedObservationResponses = 0,
    retriableMainApplyResponses = 0,
    progressingRetriableMainApplyResponses = 0,
    progressingRetryAfterMs = 0,
    retriableReplayResponses = 0,
    nonRetriableApplyResponse = false,
    operationsPlanned = 2,
    plannedOperationIds = null,
    nonProgressingMainApplyResponses = 0,
    completeBindingsOverride = null,
    completeCompletedOperationIds = null,
    activityRecordOverride = null,
    checkpointResult = null,
    checkpointFailure = null,
    snapshotSettlesAfter = 1,
    auditSettlesAfter = 1,
    progressiveContractMismatch = false,
  } = {},
) {
  const readableBaselineChannelIds =
    baselineChannelIds.length > 0 ? baselineChannelIds : baselineChannel ? [CHANNEL_ID] : [];
  const approvedOperationIds =
    plannedOperationIds ??
    Array.from({ length: operationsPlanned }, (_, index) =>
      index === 0
        ? 'channel:create:general'
        : index === 1
          ? 'publication:welcome'
          : `fixture:${index}`,
    );
  assert.equal(approvedOperationIds.length, operationsPlanned);
  const sessions = [];
  const applyBudgets = [];
  const fixtureApplyResult = (...args) => {
    const result = applyResult(...args);
    if (result.status === 'complete' || result.status === 'already_current') {
      result.evidence.activity = activity(
        args[3],
        args[4],
        result.evidence.bindings,
        completeCompletedOperationIds ?? approvedOperationIds,
        operationsPlanned,
      );
      if (activityRecordOverride !== null) {
        Object.assign(result.evidence.activity, activityRecordOverride);
      }
    }
    return result;
  };
  let firstForcedApply = true;
  let remainingPlanFailures = planCallFailures;
  let remainingApplyTransportFailures = applyTransportFailures;
  let remainingRetriableApplyResponses = retriableApplyResponses;
  let remainingRetriableVerificationResponses = retriableVerificationResponses;
  let remainingRetriableForcedObservationResponses = retriableForcedObservationResponses;
  let remainingRetriableMainApplyResponses = retriableMainApplyResponses;
  let remainingProgressingRetriableMainApplyResponses = progressingRetriableMainApplyResponses;
  let remainingRetriableReplayResponses = retriableReplayResponses;
  let remainingNonProgressingMainApplyResponses = nonProgressingMainApplyResponses;
  let nonRetriableApplyReturned = false;
  let completedApply = false;
  let forcedPartialObserved = false;
  const openSession = async (options) => {
    const calls = [];
    const session = {
      pid: 100 + sessions.length,
      options,
      calls,
      closed: false,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'mcp_tools_search') {
          const toolName =
            args.query === 'guild_blueprint_apply'
              ? 'guild_blueprint_apply'
              : args.query === 'guild_blueprint_evidence'
                ? 'guild_blueprint_evidence'
                : 'guild_blueprint_plan';
          const required =
            toolName === 'guild_blueprint_plan'
              ? ['request']
              : toolName === 'guild_blueprint_apply'
                ? ['approval_id', 'expected_bot_id', 'guild_id', 'plan_token']
                : ['expected_bot_id', 'guild_id', 'plan_id'];
          const properties = Object.fromEntries(
            [...required, ...(toolName === 'guild_blueprint_apply' ? ['__confirm'] : [])].map(
              (field) => [field, { type: field === '__confirm' ? 'boolean' : 'string' }],
            ),
          );
          const destructive = toolName === 'guild_blueprint_apply';
          return {
            query: args.query,
            category: null,
            detail: 'compact',
            total_matches: 1,
            matches: [
              {
                name: toolName,
                dispatcher:
                  progressiveContractMismatch || toolName === 'guild_blueprint_apply'
                    ? 'mcp_tools_destructive'
                    : 'mcp_tools_read',
                summary: toolName,
                description: `${toolName} fixture contract`,
                inputSchema: { type: 'object', properties, required },
                annotations: {
                  readOnlyHint: !destructive,
                  destructiveHint: destructive,
                },
              },
            ],
            categories: [],
          };
        }
        if (name === 'mcp_tools_read') {
          if (args.tool === 'guild_blueprint_plan') {
            if (remainingPlanFailures > 0) {
              remainingPlanFailures -= 1;
              throw Object.assign(new Error('guild_blueprint_plan failed (UPSTREAM_TIMEOUT)'), {
                code: 'UPSTREAM_TIMEOUT',
                source: 'mcp_tool_result',
                retriable: true,
              });
            }
            const fixturePlan = plan();
            fixturePlan.operations = approvedOperationIds.map((operation_id) => ({ operation_id }));
            return fixturePlan;
          }
          assert.equal(args.tool, 'guild_blueprint_evidence');
          const finalEvidence = structuredClone(evidenceResult);
          if (finalEvidence.record?.observed !== undefined) {
            finalEvidence.record.initial_operation_count = operationsPlanned;
            finalEvidence.record.observed.completed_operation_ids =
              completeCompletedOperationIds ?? approvedOperationIds;
            const evidencePlan = plan();
            evidencePlan.operations = approvedOperationIds.map((operation_id) => ({
              operation_id,
            }));
            finalEvidence.evidence_id = activityEvidenceDigest(evidencePlan, finalEvidence.record);
          }
          return finalEvidence;
        }
        assert.equal(name, 'mcp_tools_destructive');
        assert.equal(args.tool, 'guild_blueprint_apply');
        args = args.args;
        applyBudgets.push(args.operation_budget);
        if (remainingApplyTransportFailures > 0) {
          remainingApplyTransportFailures -= 1;
          completedApply = true;
          throw new Error('transport disconnected after apply dispatch');
        }
        if (remainingRetriableApplyResponses > 0) {
          remainingRetriableApplyResponses -= 1;
          return fixtureApplyResult('blocked', 0, 2, generatedChannelId, generatedMessageId, {
            error: {
              operation_id: null,
              code: 'UPSTREAM_TIMEOUT',
              retriable: true,
              status: null,
              ...(retriableApplyRetryAfterMs === undefined
                ? {}
                : { retry_after_ms: retriableApplyRetryAfterMs }),
            },
          });
        }
        if (remainingRetriableVerificationResponses > 0) {
          remainingRetriableVerificationResponses -= 1;
          const result = fixtureApplyResult(
            'partial',
            0,
            0,
            generatedChannelId,
            generatedMessageId,
            {
              error: {
                operation_id: null,
                code: 'UPSTREAM_TIMEOUT',
                retriable: true,
                status: null,
              },
            },
          );
          result.progress.completed_total = 2;
          return result;
        }
        if (
          mode === 'forced_resume' &&
          !forcedPartialObserved &&
          remainingRetriableForcedObservationResponses > 0
        ) {
          remainingRetriableForcedObservationResponses -= 1;
          return fixtureApplyResult('partial', 0, 1, generatedChannelId, generatedMessageId, {
            error: {
              operation_id: null,
              code: 'UPSTREAM_TIMEOUT',
              retriable: true,
              status: null,
            },
          });
        }
        if (
          !completedApply &&
          (mode !== 'forced_resume' || forcedPartialObserved) &&
          remainingProgressingRetriableMainApplyResponses > 0
        ) {
          const completedTotal =
            progressingRetriableMainApplyResponses -
            remainingProgressingRetriableMainApplyResponses +
            1;
          remainingProgressingRetriableMainApplyResponses -= 1;
          const result = fixtureApplyResult(
            'partial',
            0,
            Math.max(1, operationsPlanned - completedTotal),
            generatedChannelId,
            generatedMessageId,
            {
              error: {
                operation_id: null,
                code: 'DISCORD_RATE_LIMITED',
                retriable: true,
                status: 429,
                retry_after_ms: progressingRetryAfterMs,
              },
            },
          );
          result.progress.initial_planned = operationsPlanned;
          result.progress.completed_total = completedTotal;
          result.progress.checkpoint_version = completedTotal;
          return result;
        }
        if (
          !completedApply &&
          (mode !== 'forced_resume' || forcedPartialObserved) &&
          remainingRetriableMainApplyResponses > 0
        ) {
          remainingRetriableMainApplyResponses -= 1;
          return fixtureApplyResult('partial', 0, 1, generatedChannelId, generatedMessageId, {
            error: {
              operation_id: null,
              code: 'UPSTREAM_TIMEOUT',
              retriable: true,
              status: null,
            },
          });
        }
        if (completedApply && remainingRetriableReplayResponses > 0) {
          remainingRetriableReplayResponses -= 1;
          return fixtureApplyResult('partial', 0, 0, generatedChannelId, generatedMessageId, {
            error: {
              operation_id: null,
              code: 'UPSTREAM_TIMEOUT',
              retriable: true,
              status: null,
            },
          });
        }
        if (nonRetriableApplyResponse && !nonRetriableApplyReturned) {
          nonRetriableApplyReturned = true;
          return fixtureApplyResult('blocked', 0, 2, generatedChannelId, generatedMessageId, {
            error: {
              operation_id: null,
              code: 'DISCORD_PERMISSION_DENIED',
              retriable: false,
              status: 403,
            },
            next_action: 'fix_configuration',
          });
        }
        if (!completedApply && remainingNonProgressingMainApplyResponses > 0) {
          remainingNonProgressingMainApplyResponses -= 1;
          const stalled = fixtureApplyResult('partial', 0, operationsPlanned);
          return {
            ...stalled,
            progress: {
              ...stalled.progress,
              initial_planned: operationsPlanned,
              completed_total: 0,
              checkpoint_version: 0,
            },
            evidence: { ...stalled.evidence, completed_operation_ids: [] },
          };
        }
        if (mode === 'forced_resume' && firstForcedApply) {
          firstForcedApply = false;
          forcedPartialObserved = true;
          return fixtureApplyResult('partial', 1, 1, generatedChannelId, generatedMessageId);
        }
        if (mode === 'forced_resume' && failResume) throw new Error('injected resume failure');
        if (completedApply) {
          return fixtureApplyResult(
            'already_current',
            0,
            0,
            generatedChannelId,
            generatedMessageId,
          );
        }
        completedApply = true;
        const completed = fixtureApplyResult(
          'complete',
          1,
          0,
          generatedChannelId,
          generatedMessageId,
        );
        if (completeBindingsOverride !== null) {
          completed.evidence.bindings = structuredClone(completeBindingsOverride);
        }
        if (completeCompletedOperationIds !== null) {
          completed.evidence.completed_operation_ids = [...completeCompletedOperationIds];
        }
        return completed;
      },
      async close() {
        this.closed = true;
        if (closeFailure) throw new Error('injected close failure');
      },
    };
    sessions.push(session);
    return session;
  };
  let snapshotCall = 0;
  let snapshotOracleCall = 0;
  let auditCall = 0;
  const snapshotRequests = [];
  const settleSleeps = [];
  const checkpointLoads = [];
  return {
    sessions,
    applyBudgets,
    snapshotRequests,
    settleSleeps,
    checkpointLoads,
    dependencies: {
      openSession,
      async readSnapshot({ messageChannelIds }) {
        snapshotCall += 1;
        snapshotRequests.push([...messageChannelIds]);
        return {
          fingerprint:
            snapshotCall === 1 ? 'baseline' : snapshotCall === 2 ? planFingerprint : 'final',
          ...(baselineChannel
            ? { channels: readableBaselineChannelIds.map((id) => ({ id, type: 0 })) }
            : {}),
          messageChannelIds,
        };
      },
      snapshotFingerprint(snapshot) {
        return snapshot.fingerprint;
      },
      async readAuditCursor() {
        return '555000555000555000';
      },
      async readAuditTrail() {
        auditCall += 1;
        if (auditCall < auditSettlesAfter) return { entries: [], complete: true };
        return { entries: [{ id: '444000444000444000' }], complete: true };
      },
      buildExpectations() {
        return {};
      },
      compareSnapshots() {
        snapshotOracleCall += 1;
        if (snapshotOracleCall < snapshotSettlesAfter) {
          return {
            pass: false,
            serious_permission_failures: [],
            functional_failures: [{ code: 'STATE_NOT_SETTLED' }],
          };
        }
        return { pass: true, serious_permission_failures: [], functional_failures: [] };
      },
      verifyBlueprintSnapshot() {
        return {
          match: true,
          failures: [],
          verified_counts: {
            roles: 1,
            categories: 1,
            channels: 1,
            automod_rules: 1,
            publications: 1,
            onboarding_prompts: 1,
            onboarding_options: 1,
          },
        };
      },
      verifyAuditTrail() {
        return { pass: true, serious_permission_failures: [], functional_failures: [] };
      },
      async loadCheckpoint(options) {
        checkpointLoads.push(structuredClone(options));
        if (checkpointFailure !== null) throw checkpointFailure;
        return checkpointResult === null ? null : structuredClone(checkpointResult);
      },
      async sleep(milliseconds) {
        settleSleeps.push(milliseconds);
      },
    },
  };
}

function input(mode, dependencies) {
  return {
    trial: trial(mode),
    request: 'Build a professional gaming Discord server',
    cliPath: 'C:\\repo\\dist\\cli.js',
    cwd: 'C:\\repo',
    token: 'discord-token-never-reported',
    stateDirectory: `C:\\state\\${mode}`,
    baselineMessageChannelId: BASELINE_CHANNEL_ID,
    dependencies,
  };
}

describe('real benchmark trial orchestration', () => {
  it('fails closed when progressive discovery returns a mismatched dispatcher', async () => {
    const test = harness('full', { progressiveContractMismatch: true });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.equal(outcome.result.apply_calls, 0);
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'PROGRESSIVE_DISCOVERY_INVALID',
      ),
    );
  });

  it('runs a full apply, idempotent replay, fresh-process evidence, and all independent oracles', async () => {
    const test = harness('full');
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'complete');
    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.plan_snapshot_unchanged, true);
    assert.equal(outcome.result.progressive_discovery_succeeded, true);
    assert.equal(outcome.result.dry_run_observed_before_apply, true);
    assert.equal(outcome.result.replay_status, 'already_current');
    assert.equal(outcome.result.evidence_status, 'verified');
    assert.equal(outcome.result.plan_id, PLAN_ID);
    assert.equal(outcome.result.blueprint_id, BLUEPRINT_ID);
    assert.deepEqual(outcome.result.template_evidence.primary, {
      code: 'gaming-primary',
      catalog_version: 'fixture-catalog-v1',
      fetched_at: '2026-08-12T00:00:00.000Z',
      use_url: 'https://discord.new/gaming-primary',
      verified: true,
      code_match: true,
      permission_handling: 'discarded_and_regenerated',
      contributes: ['gaming'],
      structural_contributions: ['categories', 'text_channels', 'custom_roles'],
      evidence_digest: TEMPLATE_DIGEST,
      source_guild: {
        id: '999000999000999002',
        snapshot_id: 'source-snapshot',
        icon_hash: null,
        preferred_locale: 'en-US',
      },
    });
    assert.deepEqual(outcome.result.activity_evidence.blueprint_counts, {
      roles: 1,
      categories: 1,
      channels: 1,
      automod_rules: 1,
      publications: 1,
      onboarding_prompts: 1,
      onboarding_options: 1,
    });
    assert.equal(outcome.result.restart_count, 1);
    assert.deepEqual(test.applyBudgets, [10, 10]);
    assert.equal(test.sessions.length, 2);
    assert.ok(test.sessions.every((session) => session.closed));
    const planDispatch = test.sessions
      .flatMap((session) => session.calls)
      .find((call) => call.name === 'mcp_tools_read' && call.args.tool === 'guild_blueprint_plan');
    assert.deepEqual(planDispatch?.args.args, {
      request: 'Build a professional gaming Discord server',
    });
    assert.deepEqual(outcome.cleanup.bindings, bindings());
    assert.deepEqual(outcome.cleanup.message_channel_ids, [BASELINE_CHANNEL_ID, CHANNEL_ID]);
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
    assert.equal(Object.hasOwn(outcome.cleanup, 'blueprint'), false);
    assert.equal(Object.hasOwn(outcome.cleanup, 'plan_token'), false);
    assert.doesNotMatch(JSON.stringify(outcome), /opaque-plan-token|discord-token-never-reported/);
    assert.deepEqual(test.snapshotRequests.slice(0, 2), [
      [BASELINE_CHANNEL_ID],
      [BASELINE_CHANNEL_ID],
    ]);
    assert.equal(
      test.snapshotRequests.some((ids) => ids.length === 0),
      false,
    );
  });

  it('fails closed when an inspiration has no bounded contribution', async () => {
    const test = harness('full');
    const originalOpenSession = test.dependencies.openSession;
    test.dependencies.openSession = async (options) => {
      const session = await originalOpenSession(options);
      const originalCallTool = session.callTool;
      session.callTool = async (name, args) => {
        const result = await originalCallTool(name, args);
        if (name === 'mcp_tools_read' && args.tool === 'guild_blueprint_plan') {
          result.source.inspirations = [
            {
              ...result.source.primary,
              code: 'decorative-inspiration',
              use_url: 'https://discord.new/decorative-inspiration',
              contributes: [],
              structural_contributions: [],
            },
          ];
        }
        return result;
      };
      return session;
    };
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'TEMPLATE_EVIDENCE_INVALID',
      ),
    );
  });

  it('fails closed when the primary has no bounded contribution', async () => {
    const test = harness('full');
    const originalOpenSession = test.dependencies.openSession;
    test.dependencies.openSession = async (options) => {
      const session = await originalOpenSession(options);
      const originalCallTool = session.callTool;
      session.callTool = async (name, args) => {
        const result = await originalCallTool(name, args);
        if (name === 'mcp_tools_read' && args.tool === 'guild_blueprint_plan') {
          result.source.primary = {
            ...result.source.primary,
            contributes: [],
            structural_contributions: [],
          };
        }
        return result;
      };
      return session;
    };
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'TEMPLATE_EVIDENCE_INVALID',
      ),
    );
  });

  it('rejects malformed Activity Evidence timestamps before accepting a trial', async () => {
    const test = harness('full', { activityRecordOverride: { recorded_at: 'not-a-timestamp' } });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, false);
    assert.ok(
      outcome.result.functional_failures.some((failure) =>
        failure.code.endsWith('EVIDENCE_INVALID'),
      ),
      JSON.stringify(outcome.result.functional_failures),
    );
  });

  it('rejects a form-valid but body-mismatched Activity Evidence digest', async () => {
    const test = harness('full', {
      activityRecordOverride: { evidence_id: `sha256:${'9'.repeat(64)}` },
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, false);
    assert.ok(
      outcome.result.functional_failures.some((failure) =>
        failure.code.endsWith('EVIDENCE_INVALID'),
      ),
      JSON.stringify(outcome.result.functional_failures),
    );
  });

  it('reads baseline and generated publication channels in the final snapshot', async () => {
    const test = harness('full', {
      baselineChannel: true,
      baselineChannelIds: [BASELINE_CHANNEL_ID],
      generatedChannelId: GENERATED_CHANNEL_ID,
      generatedMessageId: GENERATED_MESSAGE_ID,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: GENERATED_CHANNEL_ID, message_id: GENERATED_MESSAGE_ID },
    ]);
    assert.deepEqual(outcome.cleanup.message_channel_ids, [
      GENERATED_CHANNEL_ID,
      BASELINE_CHANNEL_ID,
    ]);
    assert.deepEqual(test.snapshotRequests.at(-1), [GENERATED_CHANNEL_ID, BASELINE_CHANNEL_ID]);
  });

  it('waits within a bounded retry schedule for Discord readback and audit log convergence', async () => {
    const test = harness('full', { snapshotSettlesAfter: 2, auditSettlesAfter: 2 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.audit_entry_count, 1);
    assert.deepEqual(test.settleSleeps, [250, 250]);
  });

  it('restarts and retries a retriable read-only plan error with bounded backoff', async () => {
    const test = harness('full', { planCallFailures: 1 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.restart_count, 2);
    assert.deepEqual(test.settleSleeps, [1_000]);
    assert.equal(test.sessions.length, 3);
    assert.ok(test.sessions.every((session) => session.closed));
  });

  it('waits the exact bounded Discord Retry-After outside the MCP child', async () => {
    const test = harness('full', {
      retriableApplyResponses: 1,
      retriableApplyRetryAfterMs: 240_000,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(test.settleSleeps, [240_000]);
    assert.equal(outcome.result.last_nonterminal_apply.retry_after_ms, 240_000);
  });

  it('fails closed instead of retrying before an unaffordable Retry-After', async () => {
    const test = harness('full', {
      retriableApplyResponses: 1,
      retriableApplyRetryAfterMs: 900_001,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.deepEqual(test.settleSleeps, []);
    assert.equal(outcome.result.last_nonterminal_apply.retry_after_ms, 900_001);
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET',
      ),
    );
  });

  it('reconnects and resumes the same plan after a retriable apply timeout', async () => {
    const test = harness('full', { retriableApplyResponses: 1 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(test.applyBudgets, [10, 10, 10]);
    assert.deepEqual(test.settleSleeps, [1_000]);
    assert.equal(outcome.result.restart_count, 2);
    assert.deepEqual(outcome.result.last_nonterminal_apply, {
      status: 'blocked',
      error_operation_id: null,
      error_code: 'UPSTREAM_TIMEOUT',
      error_retriable: true,
      error_status: null,
      next_action: 'resume',
      blocker_codes: [],
      blocker_resources: [],
    });
    const applyCalls = test.sessions.flatMap((session) =>
      session.calls.filter((call) => call.name === 'mcp_tools_destructive'),
    );
    assert.ok(applyCalls.every((call) => call.args.args.plan_token === plan().plan_token));
    assert.ok(applyCalls.every((call) => call.args.args.approval_id === APPROVAL_ID));
    assert.ok(applyCalls.every((call) => call.args.args.__confirm === true));
  });

  it('reconnects when final verification times out after every mutation completed', async () => {
    const test = harness('full', { retriableVerificationResponses: 1 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(test.applyBudgets, [10, 10, 10]);
    assert.deepEqual(test.settleSleeps, [1_000]);
    assert.deepEqual(outcome.result.last_nonterminal_apply, {
      status: 'partial',
      error_operation_id: null,
      error_code: 'UPSTREAM_TIMEOUT',
      error_retriable: true,
      error_status: null,
      next_action: 'resume',
      blocker_codes: [],
      blocker_resources: [],
    });
  });

  it('reconnects and reconciles after an ambiguous apply transport failure', async () => {
    const test = harness('full', { applyTransportFailures: 1 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(test.applyBudgets, [10, 10, 10]);
    assert.deepEqual(test.settleSleeps, [1_000]);
    assert.equal(outcome.result.restart_count, 2);
  });

  it('recovers cleanup bindings from an authenticated checkpoint after every apply response is lost', async () => {
    const persisted = checkpoint();
    const test = harness('full', {
      applyTransportFailures: 6,
      checkpointResult: persisted,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.equal(outcome.result.apply_calls, 6);
    assert.deepEqual(test.settleSleeps, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.deepEqual(test.checkpointLoads, [
      { stateDirectory: 'C:\\state\\full', planId: PLAN_ID },
    ]);
    assert.deepEqual(outcome.cleanup.bindings, persisted.bindings);
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
  });

  it('rejects checkpoint cleanup recovered for a different target', async () => {
    const test = harness('full', {
      applyTransportFailures: 6,
      checkpointResult: checkpoint({
        target: { guild_id: '111000111000111000', bot_id: BOT_ID },
      }),
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.cleanup.bindings, null);
    assert.ok(
      outcome.result.serious_permission_failures.some(
        (failure) => failure.code === 'CHECKPOINT_RECOVERY_REJECTED',
      ),
    );
  });

  it('rejects a tampered checkpoint loader result without using its bindings', async () => {
    const test = harness('full', {
      applyTransportFailures: 6,
      checkpointFailure: Object.assign(new Error('checkpoint auth failed'), {
        code: 'CHECKPOINT_TAMPERED',
      }),
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.cleanup.bindings, null);
    assert.ok(
      outcome.result.serious_permission_failures.some(
        (failure) => failure.code === 'CHECKPOINT_RECOVERY_REJECTED',
      ),
    );
  });

  it('rejects a checkpoint binding that conflicts with the last trusted response', async () => {
    const test = harness('forced_resume', {
      failResume: true,
      checkpointResult: checkpoint({
        bindings: bindings(GENERATED_CHANNEL_ID, MESSAGE_ID),
      }),
    });
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.deepEqual(outcome.cleanup.bindings, bindings());
    assert.ok(
      outcome.result.serious_permission_failures.some(
        (failure) => failure.code === 'CHECKPOINT_RECOVERY_REJECTED',
      ),
    );
  });

  it('stops after a bounded number of consecutive no-progress responses', async () => {
    const test = harness('full', {
      operationsPlanned: 46,
      nonProgressingMainApplyResponses: 20,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'partial');
    assert.equal(outcome.result.apply_calls, 5);
    assert.deepEqual(
      test.applyBudgets,
      Array.from({ length: 5 }, () => 10),
    );
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'APPLY_DID_NOT_COMPLETE',
      ),
    );
  });

  it('resets the bounded recovery budget when apply makes real progress', async () => {
    const test = harness('full', {
      operationsPlanned: 7,
      progressingRetriableMainApplyResponses: 6,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.deepEqual(
      test.settleSleeps,
      Array.from({ length: 6 }, () => 1_000),
    );
    assert.equal(outcome.result.apply_calls, 8);
  });

  it('bounds cumulative external recovery waits even when every response makes progress', async () => {
    const test = harness('full', {
      operationsPlanned: 5,
      progressingRetriableMainApplyResponses: 4,
      progressingRetryAfterMs: 240_000,
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.deepEqual(test.settleSleeps, [240_000, 240_000, 240_000]);
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET',
      ),
    );
  });

  it('rejects apply bindings outside the signed blueprint domain before cleanup', async () => {
    const test = harness('full', {
      completeBindingsOverride: {
        ...bindings(),
        channels: { foreign: CHANNEL_ID },
      },
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.cleanup.bindings, null);
    assert.ok(
      outcome.result.serious_permission_failures.some(
        (failure) => failure.code === 'APPLY_BINDINGS_INVALID',
      ),
    );
  });

  it('rejects unknown or duplicate completed operation evidence', async () => {
    const test = harness('full', {
      completeCompletedOperationIds: ['channel:create:general', 'unknown:operation'],
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.cleanup.bindings, null);
    assert.ok(
      outcome.result.functional_failures.some(
        (failure) => failure.code === 'APPLY_RESPONSE_INVALID',
      ),
    );
  });

  it('does not retry a non-retriable apply blocker and preserves safe diagnostics', async () => {
    const test = harness('full', { nonRetriableApplyResponse: true });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'blocked');
    assert.deepEqual(test.applyBudgets, [10]);
    assert.deepEqual(test.settleSleeps, []);
    assert.deepEqual(outcome.result.last_nonterminal_apply, {
      status: 'blocked',
      error_operation_id: null,
      error_code: 'DISCORD_PERMISSION_DENIED',
      error_retriable: false,
      error_status: 403,
      next_action: 'fix_configuration',
      blocker_codes: [],
      blocker_resources: [],
    });
  });

  it('cannot pass when an independent oracle returns false with empty failure arrays', async () => {
    for (const override of [
      (dependencies) => {
        dependencies.compareSnapshots = () => ({
          pass: false,
          serious_permission_failures: [],
          functional_failures: [],
        });
      },
      (dependencies) => {
        dependencies.verifyBlueprintSnapshot = () => ({
          match: false,
          failures: [],
          verified_counts: {
            roles: 1,
            categories: 1,
            channels: 1,
            automod_rules: 1,
            publications: 1,
            onboarding_prompts: 1,
            onboarding_options: 1,
          },
        });
      },
      (dependencies) => {
        dependencies.verifyAuditTrail = () => ({
          pass: false,
          serious_permission_failures: [],
          functional_failures: [],
        });
      },
    ]) {
      const test = harness('full');
      override(test.dependencies);
      const outcome = await runBenchmarkTrial(input('full', test.dependencies));
      assert.equal(outcome.result.oracle_match, false);
    }
  });

  it('rejects missing, duplicate, and invalid publication associations', () => {
    const blueprint = plan().blueprint;
    assert.deepEqual(
      publicationTargets(
        blueprint,
        { ...bindings(), publications: {} },
        { requireComplete: false },
      ),
      [],
    );
    assert.throws(
      () => publicationTargets(blueprint, { ...bindings(), publications: {} }),
      /PUBLICATION_BINDING_INVALID/,
    );
    assert.throws(
      () =>
        publicationTargets(
          {
            ...blueprint,
            components_v2: {
              publications: [
                { key: 'welcome', channel_key: 'general' },
                { key: 'welcome', channel_key: 'general' },
              ],
            },
          },
          bindings(),
        ),
      /PUBLICATION_BINDING_INVALID/,
    );
    assert.throws(
      () => publicationTargets(blueprint, bindings('not-a-snowflake', MESSAGE_ID)),
      /PUBLICATION_BINDING_INVALID/,
    );
  });

  it('forces a one-operation partial, closes the process, and resumes from the same state directory', async () => {
    const test = harness('forced_resume');
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'complete');
    assert.equal(outcome.result.forced_resume_observed, true);
    assert.equal(outcome.result.restart_count, 2);
    assert.deepEqual(test.applyBudgets, [1, 10, 10]);
    assert.equal(test.sessions.length, 3);
    assert.ok(test.sessions.every((session) => session.closed));
    assert.ok(
      test.sessions.every(
        (session) => session.options.env.MCP_BLUEPRINT_STATE_DIR === 'C:\\state\\forced_resume',
      ),
    );
    assert.ok(
      test.sessions.every((session) => session.options.env.MCP_TOOL_SURFACE === 'progressive'),
    );
  });

  it('accepts exact final readback when a planned operation became a reconciled no-op', async () => {
    const missingOperationId = 'channel_order:managed_channels:ensure';
    const plannedOperationIds = [
      'channel:create:general',
      'publication:welcome',
      ...Array.from({ length: 39 }, (_, index) => `fixture:${index + 2}`),
      missingOperationId,
    ];
    const completedOperationIds = plannedOperationIds.filter(
      (operationId) => operationId !== missingOperationId,
    );
    const test = harness('forced_resume', {
      operationsPlanned: 42,
      plannedOperationIds,
      completeCompletedOperationIds: completedOperationIds,
    });
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'complete');
    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.activity_evidence.initial_operation_count, 42);
    assert.equal(outcome.result.activity_evidence.completed_operation_count, 41);
    assert.deepEqual(
      outcome.result.activity_evidence.evidence_body.observed.completed_operation_ids,
      completedOperationIds,
    );
    assert.deepEqual(outcome.result.functional_failures, []);
    assert.deepEqual(outcome.result.serious_permission_failures, []);
  });

  it('uses an independent five-step recovery budget for every forced, main, and replay phase', async () => {
    const test = harness('forced_resume', {
      retriableForcedObservationResponses: 4,
      retriableMainApplyResponses: 4,
      retriableReplayResponses: 4,
    });
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.forced_resume_observed, true);
    assert.equal(outcome.result.apply_calls, 15);
    assert.deepEqual(test.applyBudgets, [1, 1, 1, 1, 1, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    assert.deepEqual(
      test.settleSleeps,
      [1_000, 2_000, 4_000, 8_000, 1_000, 2_000, 4_000, 8_000, 1_000, 2_000, 4_000, 8_000],
    );
    assert.equal(outcome.result.replay_status, 'already_current');
    assert.equal(outcome.result.eligible, true);
  });

  it('keeps a trial eligible when the bounded structured recovery budget is exhausted', async () => {
    const test = harness('full', { retriableMainApplyResponses: 6 });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.eligible, true);
    assert.equal(outcome.result.oracle_match, false);
    assert.equal(outcome.result.terminal_status, 'partial');
    assert.deepEqual(test.settleSleeps, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.deepEqual(outcome.result.last_nonterminal_apply, {
      status: 'partial',
      error_operation_id: null,
      error_code: 'UPSTREAM_TIMEOUT',
      error_retriable: true,
      error_status: null,
      next_action: 'resume',
      blocker_codes: [],
      blocker_resources: [],
    });
  });

  it('retains exact partial publication cleanup targets when resume fails', async () => {
    const test = harness('forced_resume', { failResume: true });
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
    assert.deepEqual(outcome.cleanup.message_channel_ids, [BASELINE_CHANNEL_ID, CHANNEL_ID]);
    assert.ok(
      outcome.result.functional_failures.some((item) => item.code === 'TRIAL_EXECUTION_FAILED'),
    );
    assert.equal(
      outcome.result.serious_permission_failures.some(
        (item) => item.code === 'CLEANUP_METADATA_INVALID',
      ),
      false,
    );
  });

  it('quarantines cleanup when MCP session termination cannot be confirmed', async () => {
    const test = harness('full', { closeFailure: true });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.ok(
      outcome.result.functional_failures.some((item) => item.code === 'SESSION_CLOSE_FAILED'),
    );
    assert.deepEqual(outcome.cleanup.publication_targets, []);
    assert.equal(outcome.cleanup.bindings, null);
    assert.ok(
      outcome.result.serious_permission_failures.some(
        (item) => item.code === 'SESSION_TERMINATION_UNCONFIRMED',
      ),
    );
  });

  it('fails closed before apply when the read-only plan changes Discord state', async () => {
    const test = harness('full', { planFingerprint: 'mutated', baselineChannel: true });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.equal(outcome.result.oracle_match, false);
    assert.deepEqual(outcome.result.serious_permission_failures, [
      { code: 'PLAN_MUTATED_DISCORD' },
    ]);
    assert.equal(test.applyBudgets.length, 0);
    assert.equal(test.sessions.length, 1);
    assert.equal(test.sessions[0].closed, true);
  });

  it('detects a planning message side effect in any existing text channel', async () => {
    const test = harness('full');
    const snapshotRequests = [];
    let snapshotCall = 0;
    test.dependencies.readSnapshot = async ({ messageChannelIds }) => {
      snapshotCall += 1;
      snapshotRequests.push([...messageChannelIds]);
      return {
        fingerprint: snapshotCall < 3 ? 'baseline' : 'mutated',
        channels: [
          { id: BASELINE_CHANNEL_ID, type: 0 },
          { id: GENERATED_CHANNEL_ID, type: 0 },
        ],
        messageChannelIds,
      };
    };

    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.equal(outcome.result.oracle_match, false);
    assert.deepEqual(outcome.result.serious_permission_failures, [
      { code: 'PLAN_MUTATED_DISCORD' },
    ]);
    assert.deepEqual(snapshotRequests.slice(0, 3), [
      [BASELINE_CHANNEL_ID],
      [GENERATED_CHANNEL_ID, BASELINE_CHANNEL_ID],
      [GENERATED_CHANNEL_ID, BASELINE_CHANNEL_ID],
    ]);
    assert.equal(test.applyBudgets.length, 0);
  });

  it('fails closed when restart-safe Activity Evidence is not verified', async () => {
    const test = harness('full', {
      evidenceResult: { ...evidence(), status: 'drifted' },
    });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'complete');
    assert.equal(outcome.result.oracle_match, false);
    assert.deepEqual(outcome.result.functional_failures, [
      { code: 'ACTIVITY_EVIDENCE_NOT_VERIFIED' },
    ]);
  });
});
