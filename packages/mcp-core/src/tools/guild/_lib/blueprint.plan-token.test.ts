import { describe, expect, it } from 'vitest';
import { emptyBlueprintBindings } from './blueprint.execution.schema.js';
import { compileGuildBlueprint } from './blueprint.js';
import {
  BlueprintPlanTokenError,
  decodeBlueprintPlan,
  encodeBlueprintPlan,
} from './blueprint.plan-token.js';

const SIGNING_SECRET = 'Bot test-signing-secret-that-is-long-enough-for-a-real-profile';

function planPayload() {
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
  return {
    schema_version: 'guild_blueprint_plan.v1' as const,
    policy_version: 'safe-reconcile.v1' as const,
    target: { guild_id: '100000000000000001', bot_id: '100000000000000002' },
    blueprint_id: `sha256:${'1'.repeat(64)}`,
    blueprint,
    initial_snapshot_id: `sha256:${'2'.repeat(64)}`,
    initial_bindings: emptyBlueprintBindings(),
    initial_operations: [],
    policy: {
      deletions: false as const,
      ambiguous_matches: 'block' as const,
      unbound_drift: 'block' as const,
      auto_grant_bot_permissions: false as const,
      managed_roles: 'immutable' as const,
      publication_idempotency: 'marker_and_discord_nonce' as const,
    },
  };
}

describe('blueprint plan token', () => {
  it('round-trips deterministically and derives a stable approval id', () => {
    const first = encodeBlueprintPlan(planPayload(), SIGNING_SECRET);
    const second = encodeBlueprintPlan(planPayload(), SIGNING_SECRET);

    expect(first).toEqual(second);
    expect(first.plan_token).toMatch(/^dmbp1\.[a-f0-9]{64}\.[a-f0-9]{64}\.[A-Za-z0-9_-]+$/);
    expect(decodeBlueprintPlan(first.plan_token, SIGNING_SECRET)).toEqual({
      payload: planPayload(),
      plan_id: first.plan_id,
      approval_id: first.approval_id,
    });
  });

  it('rejects tampering without attempting to accept a different payload', () => {
    const token = encodeBlueprintPlan(planPayload(), SIGNING_SECRET).plan_token;
    const digestStart = 'dmbp1.'.length;
    const original = token[digestStart]!;
    const tampered =
      token.slice(0, digestStart) + (original === 'a' ? 'b' : 'a') + token.slice(digestStart + 1);

    expect(() => decodeBlueprintPlan(tampered, SIGNING_SECRET)).toThrow(BlueprintPlanTokenError);
    expect(() => decodeBlueprintPlan(tampered, SIGNING_SECRET)).toThrow('authentication');
  });

  it('rejects a valid token signed by another bot profile', () => {
    const token = encodeBlueprintPlan(planPayload(), SIGNING_SECRET).plan_token;

    expect(() => decodeBlueprintPlan(token, `${SIGNING_SECRET}-other`)).toThrow('authentication');
  });

  it('rejects oversized caller-carried tokens before decompression', () => {
    const oversized = `dmbp1.${'a'.repeat(64)}.${'A'.repeat(64 * 1024)}`;

    expect(() => decodeBlueprintPlan(oversized, SIGNING_SECRET)).toThrow(BlueprintPlanTokenError);
    expect(() => decodeBlueprintPlan(oversized, SIGNING_SECRET)).toThrow('too large');
  });
});
