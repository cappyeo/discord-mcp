import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGuildBlueprintActivityEvidence,
  GuildBlueprintActivityEvidenceError,
} from './blueprint.activity-evidence.js';
import { BlueprintCheckpointStore } from './blueprint.checkpoint-store.js';
import { compileGuildBlueprint } from './blueprint.compile.js';
import type {
  BlueprintBindings,
  BlueprintCheckpoint,
  GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { encodeBlueprintPlan } from './blueprint.plan-token.js';
import { blueprintFingerprint } from './blueprint.validation.js';

const SIGNING_SECRET = 'test-activity-evidence-signing-secret';
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-activity-evidence-'));
  directories.push(directory);
  return directory;
}

function compiledBlueprint() {
  const source = {
    code: 'safe-primary',
    effective_capabilities: ['gaming', 'lfg', 'voice', 'platform'] as const,
    blueprint: {
      channel_count: 20,
      category_count: 5,
      text_channel_count: 12,
      voice_channel_count: 4,
      forum_channel_count: 1,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 20,
      role_count: 8,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  };
  return compileGuildBlueprint({
    request: 'Build a professional gaming community with LFG and events.',
    requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
    primary: source,
    inspirations: [{ ...source, code: 'safe-inspiration', effective_capabilities: ['events'] }],
  });
}

function bindingsFor(blueprint: ReturnType<typeof compiledBlueprint>): BlueprintBindings {
  let nextId = 1;
  const id = () => `100000000000000${String(nextId++).padStart(3, '0')}`;
  return {
    roles: Object.fromEntries(blueprint.roles.map((role) => [role.key, id()])),
    categories: Object.fromEntries(blueprint.categories.map((category) => [category.key, id()])),
    channels: Object.fromEntries(blueprint.channels.map((channel) => [channel.key, id()])),
    automod_rules: Object.fromEntries(blueprint.automod.rules.map((rule) => [rule.key, id()])),
    publications: Object.fromEntries(
      blueprint.components_v2.publications.map((publication) => [publication.key, id()]),
    ),
  };
}

function fixture() {
  const blueprint = compiledBlueprint();
  const bindings = bindingsFor(blueprint);
  const plan: GuildBlueprintPlanPayload = {
    schema_version: 'guild_blueprint_plan.v1',
    policy_version: 'safe-reconcile.v1',
    target: { guild_id: '100000000000000001', bot_id: '100000000000000002' },
    blueprint_id: blueprintFingerprint(blueprint),
    blueprint,
    initial_snapshot_id: `sha256:${'a'.repeat(64)}`,
    initial_bindings: {
      roles: {},
      categories: {},
      channels: {},
      automod_rules: {},
      publications: {},
    },
    initial_operations: [
      {
        operation_id: 'roles:create:member',
        phase: 'roles',
        action: 'create',
        resource: 'role',
        key: 'member',
        summary: 'Create the member role.',
        risk: 'low',
      },
    ],
    policy: {
      deletions: false,
      ambiguous_matches: 'block',
      unbound_drift: 'block',
      auto_grant_bot_permissions: false,
      managed_roles: 'immutable',
      publication_idempotency: 'marker_and_discord_nonce',
    },
  };
  const plan_id = encodeBlueprintPlan(plan, SIGNING_SECRET).plan_id;
  const checkpoint: BlueprintCheckpoint = {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id,
    blueprint_id: plan.blueprint_id,
    target: plan.target,
    version: 7,
    status: 'complete',
    bindings,
    completed_operation_ids: ['roles:create:member'],
    last_error: null,
  };
  const final_reconciliation = {
    snapshot_id: `sha256:${'b'.repeat(64)}`,
    bindings,
    operations: [],
    blockers: [],
  };
  return { plan, plan_id, checkpoint, final_reconciliation };
}

function evidenceFromFixture() {
  const item = fixture();
  return buildGuildBlueprintActivityEvidence({
    ...item,
    final_target: item.plan.target,
    recorded_at: '2026-08-11T01:02:03.000Z',
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Guild Blueprint Activity Evidence', () => {
  it('builds deterministic per-domain proof for a complete blueprint readback', () => {
    const evidence = evidenceFromFixture();

    expect(evidence).toMatchObject({
      schema_version: 'guild_blueprint_activity_evidence.v1',
      plan_id: fixture().plan_id,
      plan_invariants: {
        safety_policy: {
          source_permissions_applied: false,
          dangerous_generated_permissions: 0,
          bot_permission_grants: 0,
          discord_managed_role_mutations: 0,
        },
      },
      observed: { blueprint_readback_match: true },
    });
    expect(evidence.evidence_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.plan_invariants.expected_counts).toEqual({
      identity: 2,
      roles: evidence.blueprint.roles.length,
      categories: evidence.blueprint.categories.length,
      channels: evidence.blueprint.channels.length,
      ordering: 2,
      guild: 1,
      welcome_screen: 1,
      onboarding:
        1 +
        evidence.blueprint.onboarding.prompts.length +
        evidence.blueprint.onboarding.prompts.reduce(
          (total, prompt) => total + prompt.options.length,
          0,
        ),
      automod: evidence.blueprint.automod.rules.length,
      components_v2: evidence.blueprint.components_v2.publications.length,
    });
  });

  it('fails closed for incomplete checkpoints, final drift, and mismatched bindings', () => {
    const item = fixture();
    const input = {
      ...item,
      final_target: item.plan.target,
      recorded_at: '2026-08-11T01:02:03.000Z',
    };
    expect(() =>
      buildGuildBlueprintActivityEvidence({
        ...input,
        checkpoint: { ...item.checkpoint, status: 'partial' },
      }),
    ).toThrow(GuildBlueprintActivityEvidenceError);
    expect(() =>
      buildGuildBlueprintActivityEvidence({
        ...input,
        final_reconciliation: {
          ...item.final_reconciliation,
          operations: item.plan.initial_operations,
        },
      }),
    ).toThrow('zero operations and blockers');
    expect(() =>
      buildGuildBlueprintActivityEvidence({
        ...input,
        final_reconciliation: {
          ...item.final_reconciliation,
          bindings: { ...item.final_reconciliation.bindings, roles: {} },
        },
      }),
    ).toThrow('Checkpoint bindings do not exactly match');
  });

  it('accepts final readback proof when a crash prevented one operation checkpoint', () => {
    const item = fixture();
    const evidence = buildGuildBlueprintActivityEvidence({
      ...item,
      checkpoint: { ...item.checkpoint, completed_operation_ids: [] },
      final_target: item.plan.target,
      recorded_at: '2026-08-11T01:02:03.000Z',
    });

    expect(evidence.initial_operation_count).toBe(1);
    expect(evidence.observed.completed_operation_ids).toEqual([]);
    expect(evidence.observed.blueprint_readback_match).toBe(true);
  });

  it('labels plan-derived counts and safety as invariants, not observations', () => {
    const evidence = evidenceFromFixture();

    expect(evidence).not.toHaveProperty('verified_counts');
    expect(evidence).not.toHaveProperty('safety');
    expect(evidence.plan_invariants.expected_counts).toEqual(
      expect.objectContaining({ roles: evidence.blueprint.roles.length }),
    );
    expect(evidence.plan_invariants.safety_policy).toEqual({
      source_permissions_applied: false,
      dangerous_generated_permissions: 0,
      bot_permission_grants: 0,
      discord_managed_role_mutations: 0,
    });
    expect(evidence.observed).toEqual(
      expect.objectContaining({
        initial_snapshot_id: `sha256:${'a'.repeat(64)}`,
        final_snapshot_id: `sha256:${'b'.repeat(64)}`,
        checkpoint_version: 7,
        blueprint_readback_match: true,
      }),
    );
  });

  it('persists one authenticated evidence record across store instances without credentials', async () => {
    const stateDirectory = temporaryDirectory();
    const evidence = evidenceFromFixture();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: evidence.plan_id,
      signingSecret: SIGNING_SECRET,
    });

    await store.saveEvidence(evidence);
    await store.saveEvidence(evidence);
    await expect(
      new BlueprintCheckpointStore({
        stateDirectory,
        planId: evidence.plan_id,
        signingSecret: SIGNING_SECRET,
      }).loadEvidence(),
    ).resolves.toEqual(evidence);

    const saved = readFileSync(
      join(stateDirectory, evidence.plan_id.slice('sha256:'.length), 'activity-evidence.json'),
      'utf8',
    );
    expect(saved).not.toContain('plan_token');
    expect(saved).not.toContain('bot_token');
    expect(saved).not.toContain('dmbp1.');
  });

  it('fails closed for tampered, malformed, and conflicting records', async () => {
    const stateDirectory = temporaryDirectory();
    const evidence = evidenceFromFixture();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: evidence.plan_id,
      signingSecret: SIGNING_SECRET,
    });
    await store.saveEvidence(evidence);
    const path = join(
      stateDirectory,
      evidence.plan_id.slice('sha256:'.length),
      'activity-evidence.json',
    );
    const saved = readFileSync(path, 'utf8');
    const envelope = JSON.parse(saved) as {
      evidence: { observed: { checkpoint_version: number } };
    };
    writeFileSync(path, 'x'.repeat(1_048_577), { mode: 0o600 });
    await expect(store.loadEvidence()).rejects.toMatchObject({ code: 'EVIDENCE_MALFORMED' });

    envelope.evidence.observed.checkpoint_version = 8;
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    await expect(store.loadEvidence()).rejects.toMatchObject({ code: 'EVIDENCE_TAMPERED' });

    writeFileSync(path, '{bad-json', { mode: 0o600 });
    await expect(store.loadEvidence()).rejects.toMatchObject({ code: 'EVIDENCE_MALFORMED' });

    const conflictDirectory = temporaryDirectory();
    const conflictStore = new BlueprintCheckpointStore({
      stateDirectory: conflictDirectory,
      planId: evidence.plan_id,
      signingSecret: SIGNING_SECRET,
    });
    await conflictStore.saveEvidence(evidence);
    const item = fixture();
    const conflictingEvidence = buildGuildBlueprintActivityEvidence({
      ...item,
      final_target: item.plan.target,
      recorded_at: '2026-08-11T02:02:03.000Z',
    });
    await expect(conflictStore.saveEvidence(conflictingEvidence)).rejects.toMatchObject({
      code: 'EVIDENCE_CONFLICT',
    });
  });
});
