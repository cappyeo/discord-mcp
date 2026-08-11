import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type BlueprintBindings,
  BlueprintBindingsSchema,
  type BlueprintCheckpoint,
  BlueprintCheckpointSchema,
  type BlueprintPlanTarget,
  BlueprintPlanTargetSchema,
  type GuildBlueprintPlanPayload,
  GuildBlueprintPlanPayloadSchema,
} from './blueprint.execution.schema.js';
import type { BlueprintReconcileResult } from './blueprint.reconcile.js';
import { type GuildBlueprint, GuildBlueprintSchema } from './blueprint.schema.js';
import {
  assertBlueprintSafe,
  blueprintFingerprint,
  canonicalJson,
} from './blueprint.validation.js';

const SHA256_ID = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const GuildBlueprintVerifiedCountsSchema = z
  .object({
    identity: z.literal(2),
    roles: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    ordering: z.literal(2),
    guild: z.literal(1),
    welcome_screen: z.literal(1),
    onboarding: z.number().int().positive(),
    automod: z.number().int().nonnegative(),
    components_v2: z.number().int().nonnegative(),
  })
  .strict();

export const GuildBlueprintSafetyEvidenceSchema = z
  .object({
    source_permissions_applied: z.literal(false),
    dangerous_generated_permissions: z.literal(0),
    bot_permission_grants: z.literal(0),
    discord_managed_role_mutations: z.literal(0),
  })
  .strict();

export const GuildBlueprintActivityEvidenceSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_activity_evidence.v1'),
    evidence_id: SHA256_ID,
    recorded_at: z.string().datetime({ offset: true }),
    plan_id: SHA256_ID,
    blueprint_id: SHA256_ID,
    target: BlueprintPlanTargetSchema,
    blueprint: GuildBlueprintSchema,
    initial_snapshot_id: SHA256_ID,
    final_snapshot_id: SHA256_ID,
    checkpoint_version: z.number().int().nonnegative(),
    initial_operation_count: z.number().int().nonnegative().max(128),
    completed_operation_ids: z.array(z.string().min(1).max(160)).max(128),
    bindings: BlueprintBindingsSchema,
    verified_counts: GuildBlueprintVerifiedCountsSchema,
    safety: GuildBlueprintSafetyEvidenceSchema,
    blueprint_readback_match: z.literal(true),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      new Set(evidence.completed_operation_ids).size !== evidence.completed_operation_ids.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completed_operation_ids'],
        message: 'completed_operation_ids must be unique.',
      });
    }
    if (evidence.initial_operation_count < evidence.completed_operation_ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['initial_operation_count'],
        message: 'completed_operation_ids cannot exceed the originally approved operation count.',
      });
    }
  });

export type GuildBlueprintActivityEvidence = z.infer<typeof GuildBlueprintActivityEvidenceSchema>;
export type GuildBlueprintVerifiedCounts = z.infer<typeof GuildBlueprintVerifiedCountsSchema>;

export class GuildBlueprintActivityEvidenceError extends Error {
  public override readonly name = 'GuildBlueprintActivityEvidenceError';
}

export interface BuildGuildBlueprintActivityEvidenceInput {
  readonly plan_id: string;
  readonly plan: GuildBlueprintPlanPayload;
  readonly checkpoint: BlueprintCheckpoint;
  readonly final_target: BlueprintPlanTarget;
  readonly final_reconciliation: Pick<
    BlueprintReconcileResult,
    'snapshot_id' | 'bindings' | 'operations' | 'blockers'
  >;
  readonly recorded_at: string;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function desiredBindingKeys(blueprint: GuildBlueprint): Record<keyof BlueprintBindings, string[]> {
  return {
    roles: blueprint.roles.map((role) => role.key).sort(),
    categories: blueprint.categories.map((category) => category.key).sort(),
    channels: blueprint.channels.map((channel) => channel.key).sort(),
    automod_rules: blueprint.automod.rules.map((rule) => rule.key).sort(),
    publications: blueprint.components_v2.publications.map((publication) => publication.key).sort(),
  };
}

function assertExactBindingKeysets(blueprint: GuildBlueprint, bindings: BlueprintBindings): void {
  const desired = desiredBindingKeys(blueprint);
  for (const key of Object.keys(desired) as Array<keyof BlueprintBindings>) {
    const actual = Object.keys(bindings[key]).sort();
    if (!sameCanonical(actual, desired[key])) {
      throw new GuildBlueprintActivityEvidenceError(
        `Final ${key} bindings do not exactly match the trusted blueprint resources.`,
      );
    }
  }
}

function verifiedCounts(blueprint: GuildBlueprint): GuildBlueprintVerifiedCounts {
  return {
    identity: 2,
    roles: blueprint.roles.length,
    categories: blueprint.categories.length,
    channels: blueprint.channels.length,
    ordering: 2,
    guild: 1,
    welcome_screen: 1,
    onboarding:
      1 +
      blueprint.onboarding.prompts.length +
      blueprint.onboarding.prompts.reduce((total, prompt) => total + prompt.options.length, 0),
    automod: blueprint.automod.rules.length,
    components_v2: blueprint.components_v2.publications.length,
  };
}

function evidenceDigest(
  evidence: Omit<GuildBlueprintActivityEvidence, 'evidence_id'>,
): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(evidence)).digest('hex')}`;
}

function planDigest(plan: GuildBlueprintPlanPayload): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
}

function validateTrustedPlan(plan: GuildBlueprintPlanPayload, planId: string): void {
  const parsed = GuildBlueprintPlanPayloadSchema.safeParse(plan);
  if (!parsed.success) {
    throw new GuildBlueprintActivityEvidenceError('Plan does not satisfy the trusted plan schema.');
  }
  if (!SHA256_ID.safeParse(planId).success) {
    throw new GuildBlueprintActivityEvidenceError('plan_id must be a SHA-256 digest.');
  }
  if (planDigest(parsed.data) !== planId) {
    throw new GuildBlueprintActivityEvidenceError(
      'plan_id does not match its trusted plan payload.',
    );
  }
  if (blueprintFingerprint(parsed.data.blueprint) !== parsed.data.blueprint_id) {
    throw new GuildBlueprintActivityEvidenceError(
      'Plan blueprint_id does not match its trusted blueprint.',
    );
  }
  assertBlueprintSafe(parsed.data.blueprint);
}

/**
 * Builds immutable proof only after an exact, successful Discord readback.
 * Inputs are deliberately low-level so apply wiring must supply its own final
 * reconciliation rather than treating a local checkpoint as proof.
 */
export function buildGuildBlueprintActivityEvidence(
  input: BuildGuildBlueprintActivityEvidenceInput,
): GuildBlueprintActivityEvidence {
  validateTrustedPlan(input.plan, input.plan_id);
  const checkpoint = BlueprintCheckpointSchema.safeParse(input.checkpoint);
  if (
    !checkpoint.success ||
    checkpoint.data.status !== 'complete' ||
    checkpoint.data.last_error !== null
  ) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence requires a complete checkpoint.',
    );
  }
  if (
    checkpoint.data.plan_id !== input.plan_id ||
    checkpoint.data.blueprint_id !== input.plan.blueprint_id ||
    !sameCanonical(checkpoint.data.target, input.plan.target) ||
    !sameCanonical(input.final_target, input.plan.target)
  ) {
    throw new GuildBlueprintActivityEvidenceError(
      'Plan, checkpoint, and final readback must have the exact same identities and target.',
    );
  }
  if (
    input.final_reconciliation.operations.length !== 0 ||
    input.final_reconciliation.blockers.length !== 0
  ) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence requires a final reconciliation with zero operations and blockers.',
    );
  }
  if (!sameCanonical(checkpoint.data.bindings, input.final_reconciliation.bindings)) {
    throw new GuildBlueprintActivityEvidenceError(
      'Checkpoint bindings do not exactly match final readback bindings.',
    );
  }
  assertExactBindingKeysets(input.plan.blueprint, checkpoint.data.bindings);

  const initialIds = new Set(
    input.plan.initial_operations.map((operation) => operation.operation_id),
  );
  const completedIds = [...checkpoint.data.completed_operation_ids].sort();
  if (completedIds.some((operationId) => !initialIds.has(operationId))) {
    throw new GuildBlueprintActivityEvidenceError(
      'Completed operations must be a subset of the originally approved operations.',
    );
  }

  const parsedRecordedAt = z.string().datetime({ offset: true }).safeParse(input.recorded_at);
  if (!parsedRecordedAt.success) {
    throw new GuildBlueprintActivityEvidenceError('recorded_at must be an ISO-8601 timestamp.');
  }
  const body = {
    schema_version: 'guild_blueprint_activity_evidence.v1' as const,
    recorded_at: parsedRecordedAt.data,
    plan_id: input.plan_id,
    blueprint_id: input.plan.blueprint_id,
    target: input.plan.target,
    blueprint: input.plan.blueprint,
    initial_snapshot_id: input.plan.initial_snapshot_id,
    final_snapshot_id: input.final_reconciliation.snapshot_id,
    checkpoint_version: checkpoint.data.version,
    initial_operation_count: input.plan.initial_operations.length,
    completed_operation_ids: completedIds,
    bindings: checkpoint.data.bindings,
    verified_counts: verifiedCounts(input.plan.blueprint),
    safety: {
      source_permissions_applied: false as const,
      dangerous_generated_permissions: 0 as const,
      bot_permission_grants: 0 as const,
      discord_managed_role_mutations: 0 as const,
    },
    blueprint_readback_match: true as const,
  };
  const evidence = { ...body, evidence_id: evidenceDigest(body) };
  return GuildBlueprintActivityEvidenceSchema.parse(evidence);
}

/** Validates a persisted proof again before it is exposed or relied upon. */
export function assertGuildBlueprintActivityEvidence(
  evidence: GuildBlueprintActivityEvidence,
): void {
  const parsed = GuildBlueprintActivityEvidenceSchema.safeParse(evidence);
  if (!parsed.success) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence does not satisfy its strict schema.',
    );
  }
  const { evidence_id: actualId, ...body } = parsed.data;
  if (actualId !== evidenceDigest(body)) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence digest does not match its body.',
    );
  }
  if (blueprintFingerprint(parsed.data.blueprint) !== parsed.data.blueprint_id) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence blueprint_id does not match its blueprint.',
    );
  }
  assertBlueprintSafe(parsed.data.blueprint);
  assertExactBindingKeysets(parsed.data.blueprint, parsed.data.bindings);
  if (!sameCanonical(parsed.data.verified_counts, verifiedCounts(parsed.data.blueprint))) {
    throw new GuildBlueprintActivityEvidenceError(
      'Activity Evidence verified counts do not match its trusted blueprint.',
    );
  }
}
