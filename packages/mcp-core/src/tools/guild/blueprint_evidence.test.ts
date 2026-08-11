import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { container } from '@sapphire/pieces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import {
  buildGuildBlueprintActivityEvidence,
  type GuildBlueprintActivityEvidence,
} from './_lib/blueprint.activity-evidence.js';
import { BlueprintCheckpointStore } from './_lib/blueprint.checkpoint-store.js';
import { compileGuildBlueprint } from './_lib/blueprint.compile.js';
import type {
  BlueprintBindings,
  BlueprintCheckpoint,
  GuildBlueprintPlanPayload,
} from './_lib/blueprint.execution.schema.js';
import { encodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import type { BlueprintReconcileResult } from './_lib/blueprint.reconcile.js';
import type { BlueprintTargetSnapshot } from './_lib/blueprint.target.js';
import { blueprintFingerprint } from './_lib/blueprint.validation.js';

const mocks = vi.hoisted(() => ({
  verifyIdentity: vi.fn(),
  readTarget: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('../../identity-lock.js', () => ({
  verifyExpectedBotIdentity: mocks.verifyIdentity,
}));
vi.mock('./_lib/blueprint.target.js', () => ({
  readBlueprintTargetSnapshot: mocks.readTarget,
}));
vi.mock('./_lib/blueprint.reconcile.js', () => ({
  reconcileGuildBlueprint: mocks.reconcile,
}));

import GuildBlueprintEvidence from './blueprint_evidence.js';

const GUILD_ID = '100000000000000001';
const OTHER_GUILD_ID = '100000000000000003';
const BOT_ID = '100000000000000002';
const TOKEN = 'Bot evidence.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TOKEN = 'Bot evidence.other.token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DIRECT_SIGNING_SECRET = 'evidence-test-direct-signing-secret';

const directories: string[] = [];
let stateDirectory = '';
let mutationVerbs = 0;

function tool() {
  return new GuildBlueprintEvidence(
    { name: 'guild_blueprint_evidence', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_blueprint_evidence', enabled: true },
  );
}

function configuration(token = TOKEN) {
  return loadConfig({
    DISCORD_TOKEN: token,
    DISCORD_EXPECTED_BOT_ID: BOT_ID,
    ALLOWED_GUILDS: `${GUILD_ID},${OTHER_GUILD_ID}`,
    MCP_BLUEPRINT_STATE_DIR: stateDirectory,
    LOG_LEVEL: 'fatal',
  });
}

function fakeRest() {
  return {
    get: () => {
      mutationVerbs += 1;
      throw new Error('Unexpected REST access in mocked evidence test');
    },
    post: () => {
      mutationVerbs += 1;
      throw new Error('Unexpected Discord mutation');
    },
    put: () => {
      mutationVerbs += 1;
      throw new Error('Unexpected Discord mutation');
    },
    patch: () => {
      mutationVerbs += 1;
      throw new Error('Unexpected Discord mutation');
    },
    delete: () => {
      mutationVerbs += 1;
      throw new Error('Unexpected Discord mutation');
    },
  };
}

function compiledBlueprint() {
  return compileGuildBlueprint({
    request: 'Build a professional gaming community with LFG and events.',
    requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
    primary: {
      code: 'safe-primary',
      effective_capabilities: ['gaming', 'lfg', 'voice', 'events'],
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
    },
    inspirations: [],
  });
}

function bindingsFor(blueprint: ReturnType<typeof compiledBlueprint>): BlueprintBindings {
  let number = 1;
  const id = () => `200000000000000${String(number++).padStart(3, '0')}`;
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

function evidenceFixture() {
  const blueprint = compiledBlueprint();
  const bindings = bindingsFor(blueprint);
  const plan: GuildBlueprintPlanPayload = {
    schema_version: 'guild_blueprint_plan.v1',
    policy_version: 'safe-reconcile.v1',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
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
  const planId = encodeBlueprintPlan(plan, DIRECT_SIGNING_SECRET).plan_id;
  const checkpoint: BlueprintCheckpoint = {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id: planId,
    blueprint_id: plan.blueprint_id,
    target: plan.target,
    version: 7,
    status: 'complete',
    bindings,
    completed_operation_ids: ['roles:create:member'],
    last_error: null,
  };
  const evidence = buildGuildBlueprintActivityEvidence({
    plan_id: planId,
    plan,
    checkpoint,
    final_target: plan.target,
    final_reconciliation: {
      snapshot_id: `sha256:${'b'.repeat(64)}`,
      bindings,
      operations: [],
      blockers: [],
    },
    recorded_at: '2026-08-11T01:02:03.000Z',
  });
  return { plan, planId, bindings, evidence };
}

function snapshot(): BlueprintTargetSnapshot {
  return {
    guild: {
      id: GUILD_ID,
      name: 'Evidence test guild',
      owner_id: '100000000000000009',
      description: null,
      preferred_locale: 'en-US',
      features: ['COMMUNITY'],
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
    },
    bot: { user: { id: BOT_ID }, roles: [] },
    roles: [],
    channels: [],
    automod_rules: [],
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    publication_history_complete: {},
  };
}

async function saveEvidence(evidence: GuildBlueprintActivityEvidence) {
  const config = configuration();
  await new BlueprintCheckpointStore({
    stateDirectory,
    planId: evidence.plan_id,
    signingSecret: config.DISCORD_TOKEN,
  }).saveEvidence(evidence);
}

async function run(planId: string, guildId = GUILD_ID) {
  return tool().run(
    { guild_id: guildId, expected_bot_id: BOT_ID, plan_id: planId },
    { signal: new AbortController().signal },
  ) as Promise<{
    readonly structuredContent: {
      readonly status: string;
      readonly blockers?: readonly { readonly code: string }[];
      readonly verification: {
        readonly readback: string;
        readonly snapshot_unchanged: boolean | null;
        readonly remaining_operations: readonly unknown[];
      };
    };
  }>;
}

beforeEach(() => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'discord-mcp-blueprint-evidence-tool-'));
  directories.push(stateDirectory);
  mutationVerbs = 0;
  container.config = configuration();
  container.rest = fakeRest() as never;
  mocks.verifyIdentity.mockResolvedValue({ id: BOT_ID, username: 'DevBot', bot: true });
  mocks.readTarget.mockResolvedValue(snapshot());
  mocks.reconcile.mockImplementation(
    (blueprintId: string, _blueprint: unknown, _snapshot: unknown, bindings: BlueprintBindings) =>
      ({
        snapshot_id: `sha256:${'b'.repeat(64)}`,
        bindings,
        operations: [],
        blockers: [],
        warnings: [],
        bot_permissions: {
          administrator: true,
          missing: [],
          top_role_id: '100000000000000010',
          top_role_position: 100,
        },
        blueprint_id: blueprintId,
      }) satisfies Partial<BlueprintReconcileResult>,
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('guild_blueprint_evidence', () => {
  it('returns not_found before every Discord read when the local proof is absent', async () => {
    const result = await run(`sha256:${'1'.repeat(64)}`);

    expect(result.structuredContent.status).toBe('not_found');
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(mutationVerbs).toBe(0);
  });

  it('fails closed for a local record bound to another explicit target before Discord access', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);

    const result = await run(fixture.planId, OTHER_GUILD_ID);

    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.verification.blockers).toEqual([
      expect.objectContaining({ code: 'EVIDENCE_TARGET_MISMATCH' }),
    ]);
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(mutationVerbs).toBe(0);
  });

  it('fails closed when the evidence belongs to another caller signing secret', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);
    container.config = configuration(OTHER_TOKEN);

    const result = await run(fixture.planId);

    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.verification.blockers).toEqual([
      expect.objectContaining({ code: 'ACTIVITY_EVIDENCE_UNVERIFIABLE' }),
    ]);
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(mutationVerbs).toBe(0);
  });

  it('fails closed when the stored evidence envelope is tampered', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);
    writeFileSync(
      join(stateDirectory, fixture.planId.slice('sha256:'.length), 'activity-evidence.json'),
      '{"schema_version":"tampered"}\n',
      'utf8',
    );

    const result = await run(fixture.planId);

    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.verification.blockers).toEqual([
      expect.objectContaining({ code: 'ACTIVITY_EVIDENCE_UNVERIFIABLE' }),
    ]);
    expect(mocks.verifyIdentity).not.toHaveBeenCalled();
    expect(mocks.readTarget).not.toHaveBeenCalled();
    expect(mutationVerbs).toBe(0);
  });

  it('returns a public immutable-record summary after an exact current readback', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);

    const result = await run(fixture.planId);

    expect(result.structuredContent).toMatchObject({
      status: 'verified',
      blueprint_id: fixture.plan.blueprint_id,
      evidence_id: fixture.evidence.evidence_id,
      record: {
        recorded_at: fixture.evidence.recorded_at,
        final_snapshot_id: fixture.evidence.final_snapshot_id,
        checkpoint_version: 7,
        completed_operation_ids: ['roles:create:member'],
      },
      verification: {
        readback: 'match',
        snapshot_unchanged: true,
        current_snapshot: { guild: { id: GUILD_ID }, bot_id: BOT_ID },
        remaining_operations: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain('"blueprint":');
    expect(mocks.verifyIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.readTarget).toHaveBeenCalledTimes(1);
    expect(mutationVerbs).toBe(0);
  });

  it('keeps blueprint conformance separate from unrelated whole-guild snapshot changes', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);
    mocks.reconcile.mockReturnValue({
      snapshot_id: `sha256:${'d'.repeat(64)}`,
      bindings: fixture.bindings,
      operations: [],
      blockers: [],
      warnings: [],
    });

    const result = await run(fixture.planId);

    expect(result.structuredContent.status).toBe('verified');
    expect(result.structuredContent.verification).toMatchObject({
      readback: 'match',
      snapshot_unchanged: false,
      remaining_operations: [],
    });
    expect(mutationVerbs).toBe(0);
  });

  it('reports drift with remaining operations and never invokes a mutation verb', async () => {
    const fixture = evidenceFixture();
    await saveEvidence(fixture.evidence);
    mocks.reconcile.mockReturnValue({
      snapshot_id: `sha256:${'d'.repeat(64)}`,
      bindings: fixture.bindings,
      operations: [
        {
          operation_id: 'roles:update:member',
          phase: 'roles',
          action: 'update',
          resource: 'role',
          key: 'member',
          summary: 'Update role Member.',
          risk: 'medium',
        },
      ],
      blockers: [],
      warnings: ['The bound role differs from its approved blueprint.'],
    });

    const result = await run(fixture.planId);

    expect(result.structuredContent.status).toBe('drifted');
    expect(result.structuredContent.verification.readback).toBe('drift');
    expect(result.structuredContent.verification.snapshot_unchanged).toBe(false);
    expect(result.structuredContent.verification.remaining_operations).toHaveLength(1);
    expect(mutationVerbs).toBe(0);
  });
});
