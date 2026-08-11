import type { REST } from '@discordjs/rest';
import { describe, expect, it } from 'vitest';
import { executeBlueprintOperation } from './blueprint.apply-executor.js';
import {
  type BlueprintOperation,
  emptyBlueprintBindings,
  type GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { blueprintFingerprint, compileGuildBlueprint } from './blueprint.js';
import type { BlueprintTargetSnapshot } from './blueprint.target.js';

const GUILD_ID = '100000000000000001';
const BOT_ID = '100000000000000002';

const blueprint = compileGuildBlueprint({
  request: 'Build a professional gaming community',
  requested_capabilities: ['gaming', 'lfg', 'voice'],
  primary: {
    code: 'primary',
    effective_capabilities: ['gaming', 'lfg', 'voice'],
    blueprint: {
      channel_count: 10,
      category_count: 2,
      text_channel_count: 6,
      voice_channel_count: 3,
      forum_channel_count: 0,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 4,
      role_count: 4,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  },
  inspirations: [],
});

const plan: GuildBlueprintPlanPayload = {
  schema_version: 'guild_blueprint_plan.v1',
  policy_version: 'safe-reconcile.v1',
  target: { guild_id: GUILD_ID, bot_id: BOT_ID },
  blueprint_id: blueprintFingerprint(blueprint),
  blueprint,
  initial_snapshot_id: `sha256:${'1'.repeat(64)}`,
  initial_bindings: emptyBlueprintBindings(),
  initial_operations: [],
  policy: {
    deletions: false,
    ambiguous_matches: 'block',
    unbound_drift: 'block',
    auto_grant_bot_permissions: false,
    managed_roles: 'immutable',
    publication_idempotency: 'marker_and_discord_nonce',
  },
};

function bindings() {
  const result = emptyBlueprintBindings();
  blueprint.roles.forEach((role, index) => {
    result.roles[role.key] = String(200_000_000_000_000_000n + BigInt(index));
  });
  blueprint.categories.forEach((category, index) => {
    result.categories[category.key] = String(210_000_000_000_000_000n + BigInt(index));
  });
  blueprint.channels.forEach((channel, index) => {
    result.channels[channel.key] = String(220_000_000_000_000_000n + BigInt(index));
  });
  return result;
}

function operation(
  resource: BlueprintOperation['resource'],
  action: BlueprintOperation['action'],
  key: string,
): BlueprintOperation {
  return {
    operation_id: `${resource}:${action}:${key}`,
    phase:
      resource === 'role_order'
        ? 'ordering'
        : resource === 'welcome_screen'
          ? 'welcome'
          : 'categories',
    action,
    resource,
    key,
    summary: 'Security response validation test.',
    risk: 'medium',
  };
}

const snapshot = {} as BlueprintTargetSnapshot;
const signal = new AbortController().signal;

describe('blueprint operation response validation', () => {
  it('rejects a guild-scoped create response that omits the target guild identity', async () => {
    const rest = {
      post: async () => ({ id: '230000000000000000' }),
    } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('category', 'create', blueprint.categories[0]!.key),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_GUILD_MISMATCH' });
  });

  it('rejects a role-order response that omits a managed role', async () => {
    const rest = { patch: async () => [] } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('role_order', 'reorder', 'generated_roles'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'DISCORD_RESPONSE_INVALID' });
  });

  it('rejects a Welcome Screen response that differs from the approved payload', async () => {
    const rest = {
      patch: async () => ({ description: 'Wrong response', welcome_channels: [] }),
    } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('welcome_screen', 'update', 'main'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'WELCOME_READBACK_MISMATCH' });
  });
});
