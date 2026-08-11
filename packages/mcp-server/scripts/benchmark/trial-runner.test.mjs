import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publicationTargets, runBenchmarkTrial } from './trial-runner.mjs';

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
    blueprint: {
      roles: [],
      categories: [],
      channels: [{ key: 'general' }],
      automod: { rules: [] },
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
  };
}

function bindings(channelId = CHANNEL_ID, messageId = MESSAGE_ID) {
  return {
    roles: {},
    categories: {},
    channels: { general: channelId },
    automod_rules: {},
    publications: { welcome: messageId },
  };
}

function applyResult(status, attempted, remaining, channelId = CHANNEL_ID, messageId = MESSAGE_ID) {
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
      completed_total: status === 'partial' ? 1 : 2,
      remaining,
      checkpoint_version: status === 'already_current' ? 2 : 1,
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
          ? { evidence_id: `sha256:${'d'.repeat(64)}` }
          : null,
    },
  };
}

function evidence() {
  return {
    status: 'verified',
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    evidence_id: `sha256:${'d'.repeat(64)}`,
    verification: { identity_verified: true, guild_verified: true, readback: 'match' },
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
    snapshotSettlesAfter = 1,
    auditSettlesAfter = 1,
  } = {},
) {
  const readableBaselineChannelIds =
    baselineChannelIds.length > 0 ? baselineChannelIds : baselineChannel ? [CHANNEL_ID] : [];
  const sessions = [];
  const applyBudgets = [];
  let firstForcedApply = true;
  const openSession = async (options) => {
    const calls = [];
    const session = {
      pid: 100 + sessions.length,
      options,
      calls,
      closed: false,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'guild_blueprint_plan') return plan();
        if (name === 'guild_blueprint_evidence') return evidenceResult;
        assert.equal(name, 'guild_blueprint_apply');
        applyBudgets.push(args.operation_budget);
        if (mode === 'forced_resume' && firstForcedApply) {
          firstForcedApply = false;
          return applyResult('partial', 1, 1, generatedChannelId, generatedMessageId);
        }
        if (mode === 'forced_resume' && failResume) throw new Error('injected resume failure');
        if (calls.filter((call) => call.name === 'guild_blueprint_apply').length > 1) {
          return applyResult('already_current', 0, 0, generatedChannelId, generatedMessageId);
        }
        return applyResult('complete', 1, 0, generatedChannelId, generatedMessageId);
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
  return {
    sessions,
    applyBudgets,
    snapshotRequests,
    settleSleeps,
    dependencies: {
      openSession,
      async readSnapshot({ messageChannelIds }) {
        snapshotCall += 1;
        snapshotRequests.push([...messageChannelIds]);
        if (baselineChannel) {
          if (snapshotCall === 1) {
            return {
              fingerprint: 'inventory',
              channels: readableBaselineChannelIds.map((id) => ({ id, type: 0 })),
              messageChannelIds,
            };
          }
          return {
            fingerprint:
              snapshotCall === 2 ? 'baseline' : snapshotCall === 3 ? planFingerprint : 'final',
            channels: readableBaselineChannelIds.map((id) => ({ id, type: 0 })),
            messageChannelIds,
          };
        }
        return {
          fingerprint:
            snapshotCall === 1 ? 'baseline' : snapshotCall === 2 ? planFingerprint : 'final',
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
          },
        };
      },
      verifyAuditTrail() {
        return { pass: true, serious_permission_failures: [], functional_failures: [] };
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
    dependencies,
  };
}

describe('real benchmark trial orchestration', () => {
  it('runs a full apply, idempotent replay, fresh-process evidence, and all independent oracles', async () => {
    const test = harness('full');
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'complete');
    assert.equal(outcome.result.oracle_match, true);
    assert.equal(outcome.result.plan_snapshot_unchanged, true);
    assert.equal(outcome.result.replay_status, 'already_current');
    assert.equal(outcome.result.evidence_status, 'verified');
    assert.equal(outcome.result.restart_count, 1);
    assert.deepEqual(test.applyBudgets, [50, 50]);
    assert.equal(test.sessions.length, 2);
    assert.ok(test.sessions.every((session) => session.closed));
    assert.deepEqual(outcome.cleanup.bindings, bindings());
    assert.deepEqual(outcome.cleanup.message_channel_ids, [CHANNEL_ID]);
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
    assert.equal(Object.hasOwn(outcome.cleanup, 'blueprint'), false);
    assert.equal(Object.hasOwn(outcome.cleanup, 'plan_token'), false);
    assert.doesNotMatch(JSON.stringify(outcome), /opaque-plan-token|discord-token-never-reported/);
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
    assert.deepEqual(test.applyBudgets, [1, 50, 50]);
    assert.equal(test.sessions.length, 3);
    assert.ok(test.sessions.every((session) => session.closed));
    assert.ok(
      test.sessions.every(
        (session) => session.options.env.MCP_BLUEPRINT_STATE_DIR === 'C:\\state\\forced_resume',
      ),
    );
  });

  it('retains exact partial publication cleanup targets when resume fails', async () => {
    const test = harness('forced_resume', { failResume: true });
    const outcome = await runBenchmarkTrial(input('forced_resume', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
    assert.deepEqual(outcome.cleanup.message_channel_ids, [CHANNEL_ID]);
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

  it('returns structured cleanup metadata when the final MCP session fails to close', async () => {
    const test = harness('full', { closeFailure: true });
    const outcome = await runBenchmarkTrial(input('full', test.dependencies));

    assert.equal(outcome.result.terminal_status, 'error');
    assert.ok(
      outcome.result.functional_failures.some((item) => item.code === 'SESSION_CLOSE_FAILED'),
    );
    assert.deepEqual(outcome.cleanup.publication_targets, [
      { channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
    ]);
    assert.deepEqual(outcome.cleanup.bindings, bindings());
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
