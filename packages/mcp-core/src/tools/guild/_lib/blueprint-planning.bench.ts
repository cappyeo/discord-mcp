import { PermissionFlagsBits } from 'discord-api-types/v10';
import { beforeAll, bench, describe, expect } from 'vitest';
import type {
  BlueprintPlanSummary,
  GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { blueprintFingerprint, compileGuildBlueprint, type GuildBlueprint } from './blueprint.js';
import { encodeBlueprintPlan } from './blueprint.plan-token.js';
import { reconcileGuildBlueprint, summarizeBlueprintOperations } from './blueprint.reconcile.js';
import type { BlueprintTargetSnapshot } from './blueprint.target.js';

/**
 * Local CPU-only benchmark: excludes template catalog/live inspection and network waits, bot
 * identity verification and REST target reads, outer request parsing, and signing-secret derivation.
 */
const GUILD_ID = '100000000000000001' as GuildBlueprintPlanPayload['target']['guild_id'];
const BOT_ID = '100000000000000002' as GuildBlueprintPlanPayload['target']['bot_id'];
const BOT_ROLE_ID = '100000000000000010';
const SIGNING_SECRET = 'local-architect-planning-benchmark-secret';
const EXPECTED_OPERATION_COUNT = 46;
const EXPECTED_OPERATION_SUMMARY: BlueprintPlanSummary = {
  total_operations: EXPECTED_OPERATION_COUNT,
  create_operations: 39,
  update_operations: 3,
  reorder_operations: 1,
  send_operations: 3,
  high_risk_operations: 2,
  by_phase: {
    roles: 10,
    categories: 6,
    channels: 20,
    ordering: 1,
    guild: 1,
    welcome: 1,
    onboarding: 1,
    automod: 3,
    publications: 3,
  },
};

function trustedSource(
  capabilities: readonly ('gaming' | 'lfg' | 'voice' | 'events')[],
  code: string,
) {
  return {
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
  };
}

function createBlueprint(): GuildBlueprint {
  return compileGuildBlueprint({
    request: 'Build a professional gaming community with LFG, voice, and events',
    requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
    primary: trustedSource(['gaming', 'lfg', 'voice'], 'benchmark-primary'),
    inspirations: [trustedSource(['events'], 'benchmark-inspiration')],
  });
}

function createSnapshot(): BlueprintTargetSnapshot {
  return {
    guild: {
      id: GUILD_ID,
      name: 'Local architect benchmark guild',
      owner_id: '100000000000000003',
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
    bot: { user: { id: BOT_ID }, roles: [BOT_ROLE_ID] },
    roles: [
      {
        id: GUILD_ID,
        name: '@everyone',
        color: 0,
        position: 0,
        permissions: '0',
        mentionable: false,
        hoist: false,
        managed: false,
      },
      {
        id: BOT_ROLE_ID,
        name: 'Benchmark bot',
        color: 0,
        position: 100,
        permissions: String(PermissionFlagsBits.Administrator),
        mentionable: false,
        hoist: false,
        managed: true,
      },
    ],
    channels: [],
    automod_rules: [],
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    publication_history_complete: {},
  };
}

function createLocalPlan() {
  const blueprint = createBlueprint();
  const blueprintId = blueprintFingerprint(blueprint);
  const reconciled = reconcileGuildBlueprint(blueprintId, blueprint, createSnapshot());
  const summary = summarizeBlueprintOperations(reconciled.operations);
  const payload: GuildBlueprintPlanPayload = {
    schema_version: 'guild_blueprint_plan.v1',
    policy_version: 'safe-reconcile.v1',
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
    blueprint_id: blueprintId,
    blueprint,
    initial_snapshot_id: reconciled.snapshot_id,
    initial_bindings: reconciled.bindings,
    initial_operations: reconciled.operations,
    policy: {
      deletions: false,
      ambiguous_matches: 'block',
      unbound_drift: 'block',
      auto_grant_bot_permissions: false,
      managed_roles: 'immutable',
      publication_idempotency: 'marker_and_discord_nonce',
    },
  };
  const encoded = encodeBlueprintPlan(payload, SIGNING_SECRET);
  return { blueprint, blueprintId, reconciled, summary, payload, encoded };
}

const firstPlan = createLocalPlan();
const secondPlan = createLocalPlan();
const blueprintBytes = Buffer.byteLength(JSON.stringify(firstPlan.blueprint), 'utf8');

function operationCount(resource: string, action: string): number {
  return firstPlan.reconciled.operations.filter(
    (operation) => operation.resource === resource && operation.action === action,
  ).length;
}

beforeAll(() => {
  expect(firstPlan.blueprintId).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(firstPlan.blueprintId).toBe(secondPlan.blueprintId);
  expect(blueprintBytes).toBe(Buffer.byteLength(JSON.stringify(secondPlan.blueprint), 'utf8'));
  expect(blueprintBytes).toBeGreaterThan(1_000);
  expect(firstPlan.reconciled.blockers).toHaveLength(0);
  expect(firstPlan.reconciled.operations).toHaveLength(EXPECTED_OPERATION_COUNT);
  expect(firstPlan.payload.initial_operations).toHaveLength(EXPECTED_OPERATION_COUNT);
  expect(firstPlan.reconciled.snapshot_id).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(firstPlan.summary).toEqual(EXPECTED_OPERATION_SUMMARY);
  expect(operationCount('role', 'create')).toBe(10);
  expect(operationCount('category', 'create')).toBe(6);
  expect(operationCount('channel', 'create')).toBe(20);
  expect(operationCount('guild', 'update')).toBe(1);
  expect(operationCount('channel_order', 'reorder')).toBe(1);
  expect(operationCount('welcome_screen', 'update')).toBe(1);
  expect(operationCount('onboarding', 'update')).toBe(1);
  expect(operationCount('automod_rule', 'create')).toBe(3);
  expect(operationCount('publication', 'send')).toBe(3);
  expect(firstPlan.reconciled.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: 'roles',
        action: 'create',
        resource: 'role',
        key: 'member',
      }),
      expect.objectContaining({
        phase: 'channels',
        action: 'create',
        resource: 'channel',
        key: 'general',
      }),
      expect.objectContaining({
        phase: 'guild',
        action: 'update',
        resource: 'guild',
        key: 'settings',
      }),
      expect.objectContaining({
        phase: 'automod',
        action: 'create',
        resource: 'automod_rule',
        key: 'mention_raid',
      }),
      expect.objectContaining({
        phase: 'publications',
        action: 'send',
        resource: 'publication',
        key: 'welcome_card',
      }),
    ]),
  );
  expect(firstPlan.encoded.plan_id).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(firstPlan.encoded.approval_id).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(firstPlan.encoded.plan_token).toMatch(
    /^dmbp1\.[a-f0-9]{64}\.[a-f0-9]{64}\.[A-Za-z0-9_-]+$/,
  );
});

describe('local architect planning benchmark', () => {
  bench('compile blueprint and fingerprint', () => {
    const blueprint = createBlueprint();
    blueprintFingerprint(blueprint);
  });

  bench('reconcile local target snapshot', () => {
    reconcileGuildBlueprint(firstPlan.blueprintId, firstPlan.blueprint, createSnapshot());
  });

  bench('summarize blueprint operations', () => {
    summarizeBlueprintOperations(firstPlan.reconciled.operations);
  });

  bench('encode authenticated plan token', () => {
    encodeBlueprintPlan(firstPlan.payload, SIGNING_SECRET);
  });

  bench('compile-reconcile-encode local CPU path', () => {
    createLocalPlan();
  });
});
