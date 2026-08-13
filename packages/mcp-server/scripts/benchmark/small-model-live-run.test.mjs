import { createHash } from 'node:crypto';

import { assertGuildBlueprintActivityEvidence } from '@discord-mcp/core';
import { describe, expect, it, vi } from 'vitest';
import {
  blueprintFingerprint,
  compileGuildBlueprint,
} from '../../../mcp-core/src/tools/guild/_lib/blueprint.js';
import { BenchmarkRestoreFailure } from './baseline-lifecycle.mjs';
import { verifySmallModelIntegrity } from './small-model-attestation.mjs';
import {
  createSmallModelLiveArtifact,
  createSmallModelLiveFailureArtifact,
  parseSmallModelLiveRunArgs,
  runSmallModelLiveTrial,
  SMALL_MODEL_LIVE_CONFIRMATION_PREFIX,
  verifySmallModelLiveArtifact,
} from './small-model-live-run.mjs';
import { activityEvidenceDigest } from './trial-runner.mjs';

const GUILD = '1537332825978568744';
const BOT = '1533719084636700773';
const SNAPSHOT = `sha256:${'5'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const TOKEN = 'test-token-only';
const PLAN_TOKEN = 'opaque-plan-token-kept-in-memory';
const PLAN_REF = `dmbpr1.${'f'.repeat(64)}`;
const digest = (value) =>
  `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;

function bindings(bp = blueprint()) {
  let nextId = 1_537_332_825_978_568_745n;
  const bind = (resources) =>
    Object.fromEntries(
      resources.map(({ key }) => {
        const id = String(nextId);
        nextId += 1n;
        return [key, id];
      }),
    );
  return {
    roles: bind(bp.roles),
    categories: bind(bp.categories),
    channels: bind(bp.channels),
    automod_rules: bind(bp.automod.rules),
    publications: bind(bp.components_v2.publications),
  };
}

function blueprint() {
  const trustedSource = (capabilities, code) => ({
    code,
    effective_capabilities: capabilities,
    blueprint: {
      channel_count: 18,
      category_count: 4,
      text_channel_count: 11,
      voice_channel_count: 4,
      forum_channel_count: 1,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 12,
      role_count: 8,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  });
  return compileGuildBlueprint({
    request: 'Build a professional gaming community with LFG, voice, and events',
    requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
    primary: trustedSource(['gaming', 'lfg', 'voice'], 'gaming-primary'),
    inspirations: [trustedSource(['events'], 'events-inspiration')],
  });
}

function plan() {
  const bp = blueprint();
  const operationDefinitions = [
    ...bp.roles.map(({ key }) => ['roles', 'create', 'role', key]),
    ...bp.categories.map(({ key }) => ['categories', 'create', 'category', key]),
    ...bp.channels.map(({ key }) => ['channels', 'create', 'channel', key]),
    ...bp.automod.rules.map(({ key }) => ['automod', 'create', 'automod_rule', key]),
    ...bp.components_v2.publications.map(({ key }) => ['publications', 'send', 'publication', key]),
  ];
  const operations = operationDefinitions.map(([phase, action, resource, key]) => ({
    operation_id: `${resource}:${action}:${key}`,
    phase,
    action,
    resource,
    key,
    summary: `${action} ${resource} ${key}`,
    risk: 'low',
  }));
  return {
    target: { guild_id: GUILD, bot_id: BOT },
    status: 'ready',
    blockers: [],
    plan_id: `sha256:${'1'.repeat(64)}`,
    blueprint_id: blueprintFingerprint(bp),
    snapshot_id: SNAPSHOT,
    approval_id: `sha256:${'3'.repeat(64)}`,
    plan_token: PLAN_TOKEN,
    plan_ref: PLAN_REF,
    source: {
      catalog_version: 'fixture-catalog-v1',
      permission_policy: 'discard_source_and_regenerate',
      primary: {
        code: 'gaming-primary',
        use_url: 'https://discord.new/gaming-primary',
        quality: {
          verified: true,
          code_match: true,
          permission_handling: 'discarded_and_regenerated',
        },
        contributes: ['gaming'],
        structural_contributions: ['categories', 'text_channels', 'custom_roles'],
        provenance: {
          evidence_digest: `sha256:${'4'.repeat(64)}`,
          fetched_at: '2026-08-12T00:00:00.000Z',
          source_guild: {
            id: '1537332825978568751',
            snapshot_id: null,
            icon_hash: null,
            preferred_locale: 'en-US',
          },
        },
      },
      inspirations: [],
    },
    blueprint: bp,
    operations,
  };
}

function activityRecord(
  p,
  completedOperationIds = p.operations.map(({ operation_id }) => operation_id),
) {
  const b = bindings(p.blueprint);
  const record = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    recorded_at: '2026-08-12T00:00:00.000Z',
    plan_id: p.plan_id,
    blueprint_id: p.blueprint_id,
    target: p.target,
    blueprint: p.blueprint,
    initial_operation_count: p.operations.length,
    plan_invariants: {
      expected_counts: {
        identity: 2,
        roles: p.blueprint.roles.length,
        categories: p.blueprint.categories.length,
        channels: p.blueprint.channels.length,
        ordering: 2,
        guild: 1,
        welcome_screen: 1,
        onboarding:
          1 +
          p.blueprint.onboarding.prompts.length +
          p.blueprint.onboarding.prompts.reduce(
            (total, prompt) => total + prompt.options.length,
            0,
          ),
        automod: p.blueprint.automod.rules.length,
        components_v2: p.blueprint.components_v2.publications.length,
      },
      safety_policy: {
        source_permissions_applied: false,
        dangerous_generated_permissions: 0,
        bot_permission_grants: 0,
        discord_managed_role_mutations: 0,
      },
    },
    observed: {
      initial_snapshot_id: p.snapshot_id,
      final_snapshot_id: p.snapshot_id,
      checkpoint_version: 1,
      completed_operation_ids: completedOperationIds,
      bindings: b,
      blueprint_readback_match: true,
    },
  };
  record.evidence_id = activityEvidenceDigest(p, record);
  return record;
}

function evidence(p) {
  const record = activityRecord(p);
  return {
    status: 'verified',
    plan_id: p.plan_id,
    blueprint_id: p.blueprint_id,
    target: p.target,
    evidence_id: record.evidence_id,
    record,
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      snapshot_unchanged: true,
      current_snapshot: {
        snapshot_id: p.snapshot_id,
        guild: { id: GUILD, name: 'Fixture Community', features: [] },
        bot_id: BOT,
      },
      remaining_operations: [],
      blockers: [],
      warnings: [],
    },
  };
}

function apply(p, overrides = {}) {
  const b = bindings(p.blueprint);
  const operationIds = p.operations.map(({ operation_id }) => operation_id);
  return {
    status: 'complete',
    plan_id: p.plan_id,
    blueprint_id: p.blueprint_id,
    target: p.target,
    progress: {
      initial_planned: operationIds.length,
      planned_this_call: operationIds.length,
      attempted_this_call: operationIds.length,
      completed_total: operationIds.length,
      remaining: 0,
      checkpoint_version: 1,
    },
    attempts: p.operations.map((operation) => ({
      operation_id: operation.operation_id,
      status: 'completed',
      resource_id:
        b[
          {
            role: 'roles',
            category: 'categories',
            channel: 'channels',
            automod_rule: 'automod_rules',
            publication: 'publications',
          }[operation.resource]
        ][operation.key],
      error_code: null,
    })),
    blockers: [],
    error: null,
    evidence: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      bindings: b,
      completed_operation_ids: operationIds,
      activity: activityRecord(p),
    },
    next_action: 'done',
    ...overrides,
  };
}

function checkpoint(p) {
  return {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id: p.plan_id,
    blueprint_id: p.blueprint_id,
    target: p.target,
    version: 1,
    status: 'complete',
    bindings: bindings(p.blueprint),
    completed_operation_ids: p.operations.map(({ operation_id }) => operation_id),
    last_error: null,
  };
}

function expectedCleanup(p = plan()) {
  const b = bindings(p.blueprint);
  const publicationTargets = p.blueprint.components_v2.publications
    .map((publication) => ({
      channel_id: b.channels[publication.channel_key],
      message_id: b.publications[publication.key],
    }))
    .sort((left, right) =>
      `${left.channel_id}:${left.message_id}`.localeCompare(
        `${right.channel_id}:${right.message_id}`,
      ),
    );
  return {
    guild_id: GUILD,
    bot_id: BOT,
    blueprint_id: p.blueprint_id,
    plan_id: p.plan_id,
    bindings: b,
    publication_targets: publicationTargets,
    message_channel_ids: [...new Set(publicationTargets.map((item) => item.channel_id))].sort(),
  };
}

function evaluation({
  fail = false,
  bindingFailure = false,
  lostApply = false,
  unclosed = false,
} = {}) {
  return async ({ approve, onValidatedToolCall }) => {
    const p = plan();
    onValidatedToolCall({
      phase: 'initial',
      tool: 'build_discord_server',
      arguments: {},
      result: p,
    });
    const approved = await approve({
      summary: {
        target: p.target,
        plan_id: p.plan_id,
        blueprint_id: p.blueprint_id,
        approval_id: p.approval_id,
        plan_ref: p.plan_ref,
      },
    });
    if (approved !== true) return { status: 'not_approved' };
    if (unclosed) {
      const error = new Error('Codex process did not close');
      error.code = 'CODEX_PROCESS_DID_NOT_CLOSE';
      throw error;
    }
    if (bindingFailure) {
      const error = new Error(`unsafe detail ${PLAN_TOKEN} C:\\private\\auth.json`);
      error.code = 'RESUME_APPLY_ARGUMENT_PLAN_REF_MISMATCH';
      error.diagnostic = {
        phase: 'resume',
        turn: 1,
        classification: 'apply_argument_plan_ref_mismatch',
        session_digest: digest('thread-secret'),
        tool: 'guild_blueprint_apply',
        call_count: 1,
        completed_call_count: 1,
        confirmed: true,
        expected: { guild_id: GUILD, expected_bot_id: BOT, plan_ref: PLAN_REF },
        observed: { guild_id: GUILD, expected_bot_id: BOT, plan_ref: `dmbpr1.${'0'.repeat(64)}` },
        matches: { argument_guild: true, argument_bot: true, argument_plan_ref: false },
        stdout: 'stdout-secret',
        auth_path: 'C:\\private\\auth.json',
      };
      throw error;
    }
    onValidatedToolCall({
      phase: 'resume',
      tool: 'guild_blueprint_apply',
      arguments: {
        guild_id: GUILD,
        expected_bot_id: BOT,
        plan_ref: p.plan_ref,
        approval_id: p.approval_id,
        __confirm: true,
      },
      result: lostApply ? { status: 'lost' } : apply(p),
    });
    if (lostApply) return { status: 'complete', trace: [{ tool: 'apply', response: 'lost' }] };
    if (fail) throw new Error('model process failed after mutation');
    onValidatedToolCall({
      phase: 'resume',
      tool: 'guild_blueprint_evidence',
      arguments: { guild_id: GUILD, expected_bot_id: BOT, plan_id: p.plan_id },
      result: evidence(p),
    });
    return {
      status: 'complete',
      session_digest: `sha256:${'8'.repeat(64)}`,
      initial_trace: [
        {
          tool: 'build_discord_server',
          status: 'completed',
          result_summary: {
            plan_id: p.plan_id,
            blueprint_id: p.blueprint_id,
            plan_ref: p.plan_ref,
          },
        },
      ],
      trace: [
        {
          tool: 'guild_blueprint_apply',
          status: 'completed',
          confirmed: true,
          argument_keys: ['approval_id', 'expected_bot_id', 'guild_id', 'plan_ref', '__confirm'],
          argument_projection: { plan_ref: p.plan_ref },
          result_summary: {
            status: 'complete',
            plan_id: p.plan_id,
            blueprint_id: p.blueprint_id,
          },
        },
        {
          tool: 'guild_blueprint_evidence',
          status: 'completed',
          result_summary: {
            status: 'verified',
            plan_id: p.plan_id,
            blueprint_id: p.blueprint_id,
            evidence_id: evidence(p).evidence_id,
          },
        },
      ],
    };
  };
}

function builtCli() {
  return {
    cliPath: 'C:\\repo\\attested-cli.js',
    cleanup: vi.fn(async () => {}),
    attestation: {
      entrypoint: 'packages/mcp-server/dist/cli.js',
      sha256: `sha256:${'6'.repeat(64)}`,
      source_commit: COMMIT,
      core_entrypoint: 'packages/mcp-core/dist/index.js',
      core_sha256: `sha256:${'7'.repeat(64)}`,
      core_source_commit: COMMIT,
      files: [{ path: 'packages/mcp-server/dist/cli.js', sha256: `sha256:${'6'.repeat(64)}` }],
      core_files: [{ path: 'packages/mcp-core/dist/index.js', sha256: `sha256:${'7'.repeat(64)}` }],
    },
  };
}

function deps({
  evaluate = evaluation(),
  restore,
  validateAttestedActivity,
  driftChecksAfterPrecheck = 0,
  driftError = 'BASELINE_FINGERPRINT_DRIFT',
  checkpointValue = '__default_checkpoint__',
} = {}) {
  const p = plan();
  const lock = { release: vi.fn(async () => {}) };
  const store = {
    createStateDirectory: vi.fn(async () => 'C:\\private\\state'),
    writeArtifact: vi.fn(async () => {}),
  };
  const runtime = {
    readSnapshot: vi.fn(async () => ({ bot: { user: { id: BOT } } })),
    loadCheckpoint: vi.fn(async () =>
      checkpointValue === '__default_checkpoint__' ? checkpoint(p) : checkpointValue,
    ),
  };
  let baselineCheck = 0;
  return {
    acquireLock: vi.fn(async () => lock),
    lock,
    readBaseline: vi.fn(async () => ({ guild_id: GUILD, bot_id: BOT, fingerprint: SNAPSHOT })),
    verifyBaseline: vi.fn(async () => {
      baselineCheck += 1;
      if (baselineCheck > 1 && baselineCheck <= 1 + driftChecksAfterPrecheck)
        throw new Error(driftError);
      return {
        verified: true,
        guild_id: GUILD,
        bot_id: BOT,
        fingerprint: SNAPSHOT,
      };
    }),
    store,
    runtime,
    evaluate,
    restore: restore ?? vi.fn(async () => ({ restored: true })),
    verifySnapshot: vi.fn(() => ({ match: true, failures: [] })),
    builtCli: builtCli(),
    validateAttestedActivity:
      validateAttestedActivity ?? vi.fn((value) => assertGuildBlueprintActivityEvidence(value)),
    sleep: vi.fn(async () => {}),
    openSession: vi.fn(async () => ({
      callTool: vi.fn(async () => evidence(p)),
      close: vi.fn(async () => {}),
    })),
  };
}

function runOptions(dependencies, runId = 'run-01') {
  return {
    cwd: 'C:\\repo',
    artifactRoot: 'C:\\artifacts',
    runId,
    expectedCommit: COMMIT,
    guildId: GUILD,
    confirmation: `${SMALL_MODEL_LIVE_CONFIRMATION_PREFIX}${GUILD}`,
    token: TOKEN,
    cliPath: 'C:\\repo\\cli.js',
    dependencies,
  };
}

describe('small-model-live-run', () => {
  it('parses only the exact controlled CLI contract', () => {
    const args = [
      '--expected-commit',
      COMMIT,
      '--artifact-root',
      'C:\\artifacts',
      '--run-id',
      'run-parse',
      '--guild',
      GUILD,
      '--confirmation',
      `${SMALL_MODEL_LIVE_CONFIRMATION_PREFIX}${GUILD}`,
    ];
    expect(parseSmallModelLiveRunArgs(args)).toEqual({
      expected_commit: COMMIT,
      artifact_root: 'C:\\artifacts',
      run_id: 'run-parse',
      guild: GUILD,
      confirmation: `${SMALL_MODEL_LIVE_CONFIRMATION_PREFIX}${GUILD}`,
    });
    expect(() => parseSmallModelLiveRunArgs([...args, '--guild', GUILD])).toThrow(
      'duplicate argument',
    );
    expect(() =>
      parseSmallModelLiveRunArgs(args.map((value) => (value === COMMIT ? 'not-a-commit' : value))),
    ).toThrow('full lowercase Git SHA');
    expect(() => parseSmallModelLiveRunArgs([...args.slice(0, -2), '--unknown', 'x'])).toThrow(
      'unknown argument',
    );
  });

  it('runs a locked one-trial lifecycle and writes a secret-free trace artifact', async () => {
    const d = deps();
    const artifact = await runSmallModelLiveTrial(runOptions(d));
    expect(artifact.summary.status).toBe('passed');
    expect(artifact.summary.evidence.digest_verified).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain(TOKEN);
    expect(JSON.stringify(artifact)).not.toContain(PLAN_TOKEN);
    expect(d.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT, guildIds: expect.arrayContaining([GUILD]) }),
    );
    expect(d.validateAttestedActivity).toHaveBeenCalledTimes(3);
    expect(d.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanup: expectedCleanup(),
      }),
    );
    expect(d.runtime.readSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ messageChannelIds: expectedCleanup().message_channel_ids }),
    );
    expect(d.store.writeArtifact).toHaveBeenCalledWith(
      'results/small-model-live.json',
      expect.any(Object),
    );
  });

  it('fails closed without exact confirmation and never acquires the lock', async () => {
    const d = deps();
    await expect(
      runSmallModelLiveTrial({ ...runOptions(d, 'run-02'), confirmation: 'yes' }),
    ).rejects.toThrow('explicit operator confirmation');
    expect(d.acquireLock).not.toHaveBeenCalled();
  });

  it('attests a safe binding-failure capsule and releases the lock when baseline is unchanged', async () => {
    const d = deps({ evaluate: evaluation({ bindingFailure: true }) });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-no-mutation'))).rejects.toThrow(
      'unsafe detail',
    );
    expect(d.restore).not.toHaveBeenCalled();
    expect(d.lock.release).toHaveBeenCalledTimes(1);
    const [artifactPath, artifact] = d.store.writeArtifact.mock.calls[0];
    expect(artifactPath).toBe('results/small-model-live.failure.json');
    expect(artifact.status).toBe('failed');
    expect(artifact.approved).toBe(true);
    expect(artifact.failure_code).toBe('RESUME_APPLY_ARGUMENT_PLAN_REF_MISMATCH');
    expect(artifact.baseline.outcome).toBe('unchanged');
    expect(artifact.restoration.outcome).toBe('not_required');
    expect(artifact.lock_retained).toBe(false);
    expect(() => verifySmallModelIntegrity({ artifact, integrityKey: TOKEN })).not.toThrow();
    const serialized = JSON.stringify(artifact);
    for (const secret of [
      TOKEN,
      PLAN_TOKEN,
      'thread-secret',
      'stdout-secret',
      'C:\\private\\auth.json',
    ])
      expect(serialized).not.toContain(secret);
    expect(artifact.diagnostic).toMatchObject({
      phase: 'resume',
      turn: 1,
      classification: 'apply_argument_plan_ref_mismatch',
      session_digest: digest('thread-secret'),
      matches: { argument_plan_ref: false },
    });
  });

  it('retains the lock and writes a safe artifact when drift has no authenticated checkpoint', async () => {
    const d = deps({
      evaluate: evaluation({ lostApply: true }),
      driftChecksAfterPrecheck: 1,
      checkpointValue: null,
    });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-no-checkpoint'))).rejects.toThrow(
      'LIVE_FAILURE_AND_RESTORE_FAILURE',
    );
    expect(d.restore).not.toHaveBeenCalled();
    expect(d.lock.release).not.toHaveBeenCalled();
    const [artifactPath, artifact] = d.store.writeArtifact.mock.calls[0];
    expect(artifactPath).toBe('results/small-model-live.failure.json');
    expect(artifact.baseline.outcome).toBe('drifted');
    expect(artifact.restoration.outcome).toBe('failed');
    expect(artifact.lock_retained).toBe(true);
    expect(() => verifySmallModelIntegrity({ artifact, integrityKey: TOKEN })).not.toThrow();
  });

  it('classifies deterministic onboarding state divergence as baseline drift', async () => {
    const d = deps({
      evaluate: evaluation({ lostApply: true }),
      driftChecksAfterPrecheck: 1,
      driftError: 'baseline onboarding is not disabled and empty',
      checkpointValue: null,
    });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-onboarding-drift'))).rejects.toThrow(
      'LIVE_FAILURE_AND_RESTORE_FAILURE',
    );
    const [, artifact] = d.store.writeArtifact.mock.calls[0];
    expect(artifact.baseline.outcome).toBe('drifted');
    expect(artifact.lock_retained).toBe(true);
  });

  it('cleans the attested build even when releasing the lock fails', async () => {
    const d = deps();
    d.lock.release.mockRejectedValueOnce(new Error('lock release failed'));
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-release-failure'))).rejects.toThrow(
      'lock release failed',
    );
    expect(d.builtCli.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains the lock when an approved failure artifact cannot be persisted', async () => {
    const d = deps({ evaluate: evaluation({ bindingFailure: true }) });
    d.store.writeArtifact.mockRejectedValueOnce(
      new Error(`disk failure ${PLAN_TOKEN} C:\\private\\auth.json`),
    );
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-failure-write'))).rejects.toThrow(
      'LIVE_FAILURE_ARTIFACT_WRITE_FAILURE',
    );
    expect(d.store.writeArtifact).toHaveBeenCalledTimes(1);
    expect(d.lock.release).not.toHaveBeenCalled();
    expect(d.builtCli.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains the lock when Codex process termination cannot be proven', async () => {
    const d = deps({ evaluate: evaluation({ unclosed: true }) });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-unclosed'))).rejects.toThrow(
      'LIVE_PROCESS_QUARANTINED',
    );
    expect(d.restore).not.toHaveBeenCalled();
    expect(d.lock.release).not.toHaveBeenCalled();
  });

  it('restores after a model failure observed after mutation and retries restore', async () => {
    const retryProof = { preflight: 'verified', operation: 'restore' };
    const restore = vi
      .fn()
      .mockRejectedValueOnce(
        new BenchmarkRestoreFailure('RESTORE_EXECUTION_AMBIGUOUS', undefined, retryProof),
      )
      .mockResolvedValue({ restored: true });
    const d = deps({
      evaluate: evaluation({ fail: true }),
      restore,
      driftChecksAfterPrecheck: 2,
    });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-03'))).rejects.toThrow(
      'model process failed',
    );
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore.mock.calls[0][0].cleanup).toEqual(expectedCleanup());
    expect(restore.mock.calls[1][0].retryProof).toEqual(retryProof);
  });

  it('recovers exact cleanup targets from a checkpoint when the apply response is lost', async () => {
    const d = deps({
      evaluate: evaluation({ lostApply: true }),
      driftChecksAfterPrecheck: 1,
    });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-04'))).rejects.toThrow(
      'APPLY_TARGET_MISMATCH',
    );
    expect(d.runtime.loadCheckpoint).toHaveBeenCalledWith({
      stateDirectory: 'C:\\private\\state',
      planId: plan().plan_id,
    });
    expect(d.restore.mock.calls[0][0].cleanup).toEqual(expectedCleanup());
  });

  it('retains the lock when baseline restoration fails a non-retryable safety guard', async () => {
    const restore = vi.fn(async () => {
      throw new BenchmarkRestoreFailure('RESTORE_SAFETY_VIOLATION');
    });
    const d = deps({
      evaluate: evaluation({ fail: true }),
      restore,
      driftChecksAfterPrecheck: 1,
    });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-restore-quarantine'))).rejects.toThrow(
      'LIVE_FAILURE_AND_RESTORE_FAILURE',
    );
    expect(restore).toHaveBeenCalledTimes(1);
    expect(d.lock.release).not.toHaveBeenCalled();
  });

  it('fails and restores when activity evidence is not attested', async () => {
    const validateAttestedActivity = vi.fn(() => {
      throw new Error('activity evidence attestation rejected');
    });
    const d = deps({ validateAttestedActivity, driftChecksAfterPrecheck: 1 });
    await expect(runSmallModelLiveTrial(runOptions(d, 'run-05'))).rejects.toThrow(
      'activity evidence attestation rejected',
    );
    expect(validateAttestedActivity).toHaveBeenCalledTimes(1);
    expect(d.restore).toHaveBeenCalled();
  });

  it('rejects a tampered or unclean artifact', () => {
    const unsigned = createSmallModelLiveArtifact({
      summary: { status: 'passed', oracle: { match: true } },
      expectedCommit: COMMIT,
      restored: true,
    });
    unsigned.integrity = {
      schema_version: 'discord-mcp.small-model-attestation.v1',
      algorithm: 'hmac-sha256',
      context: 'discord-mcp.small-model-eval:hmac:v1',
      digest: '0'.repeat(64),
    };
    expect(() =>
      verifySmallModelLiveArtifact({
        artifact: unsigned,
        integrityKey: TOKEN,
        expectedCommit: COMMIT,
      }),
    ).toThrow();
  });

  it('keeps failure artifacts bounded and allowlisted', () => {
    const artifact = createSmallModelLiveFailureArtifact({
      expectedCommit: COMMIT,
      target: { guildId: GUILD, botId: BOT },
      failureCode: 'not-allowlisted',
      baselineOutcome: 'unavailable',
      restorationOutcome: 'not_attempted',
      lockRetained: true,
      diagnostic: {
        phase: 'resume',
        expected: { guild_id: GUILD },
        observed: {
          stdout: 'stdout-secret',
          session_id: 'thread-secret',
          plan_ref: PLAN_REF,
          error_code: 'dmbp1.raw-opaque-plan-token',
        },
        auth_path: 'C:\\private\\auth.json',
      },
    });
    expect(artifact.failure_code).toBe('LIVE_FAILURE_UNCLASSIFIED');
    expect(artifact.diagnostic).toEqual({
      phase: 'resume',
      expected: { guild_id: GUILD },
      observed: { plan_ref: PLAN_REF },
    });
    expect(JSON.stringify(artifact)).not.toContain('stdout-secret');
    expect(JSON.stringify(artifact)).not.toContain('thread-secret');
    expect(JSON.stringify(artifact)).not.toContain('auth.json');
  });

  it('preserves only the evaluator failure codes and safe projections', () => {
    const artifact = createSmallModelLiveFailureArtifact({
      expectedCommit: COMMIT,
      target: { guildId: GUILD, botId: BOT },
      failureCode: 'RESUME_APPLY_ARGUMENT_PLAN_REF_MISMATCH',
      baselineOutcome: 'unchanged',
      restorationOutcome: 'not_required',
      lockRetained: false,
      diagnostic: {
        phase: 'resume',
        turn: 1,
        classification: 'apply_argument_plan_ref_mismatch',
        session_digest: digest('thread-secret'),
        tool: 'guild_blueprint_apply',
        call_count: 1,
        completed_call_count: 1,
        confirmed: true,
        expected: { guild_id: GUILD, plan_ref: PLAN_REF },
        observed: { guild_id: GUILD, plan_ref: `dmbpr1.${'0'.repeat(64)}` },
        matches: {
          argument_guild: true,
          argument_bot: true,
          argument_approval: true,
          argument_plan_ref: false,
        },
        error_code: 'DMBP1_RAW_OPAQUE_PLAN_TOKEN',
      },
    });
    expect(artifact.failure_code).toBe('RESUME_APPLY_ARGUMENT_PLAN_REF_MISMATCH');
    expect(artifact.diagnostic).toMatchObject({
      phase: 'resume',
      turn: 1,
      session_digest: digest('thread-secret'),
      expected: { guild_id: GUILD },
      observed: { guild_id: GUILD },
      matches: {
        argument_guild: true,
        argument_bot: true,
        argument_approval: true,
        argument_plan_ref: false,
      },
    });
    expect(JSON.stringify(artifact)).not.toContain('thread-secret');
    expect(JSON.stringify(artifact)).not.toContain('dmbp1.');
  });

  it('preserves the bounded apply tool-error classification without its raw message', () => {
    const artifact = createSmallModelLiveFailureArtifact({
      expectedCommit: COMMIT,
      target: { guildId: GUILD, botId: BOT },
      failureCode: 'RESUME_APPLY_TOOL_ERROR',
      baselineOutcome: 'unchanged',
      restorationOutcome: 'not_required',
      lockRetained: false,
      diagnostic: {
        phase: 'resume',
        turn: 1,
        classification: 'apply_tool_error',
        tool: 'guild_blueprint_apply',
        tool_error: true,
        raw_error: 'MCP tool timed out with sensitive local diagnostics',
      },
    });

    expect(artifact.failure_code).toBe('RESUME_APPLY_TOOL_ERROR');
    expect(artifact.diagnostic).toMatchObject({
      phase: 'resume',
      turn: 1,
      classification: 'apply_tool_error',
      tool: 'guild_blueprint_apply',
      tool_error: true,
    });
    expect(JSON.stringify(artifact)).not.toContain('sensitive local diagnostics');
  });

  it('preserves the bounded JSONL failure code without trusting arbitrary diagnostics', () => {
    const artifact = createSmallModelLiveFailureArtifact({
      expectedCommit: COMMIT,
      target: { guildId: GUILD, botId: BOT },
      failureCode: 'JSONL_LINE_LIMIT',
      baselineOutcome: 'unchanged',
      restorationOutcome: 'not_required',
      lockRetained: false,
      diagnostic: { stdout: `dmbp1.${'x'.repeat(128)}` },
    });
    expect(artifact.failure_code).toBe('JSONL_LINE_LIMIT');
    expect(artifact).not.toHaveProperty('diagnostic');
  });
});
