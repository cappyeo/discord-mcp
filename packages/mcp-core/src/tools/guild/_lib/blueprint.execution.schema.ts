import { z } from 'zod';
import { GuildId, Snowflake, UserId } from '../../_lib/snowflake.js';
import { GuildBlueprintSchema, SymbolKey } from './blueprint.schema.js';

export const BlueprintExecutionPhaseSchema = z.enum([
  'roles',
  'categories',
  'channels',
  'ordering',
  'guild',
  'welcome',
  'onboarding',
  'automod',
  'publications',
]);

export const BlueprintOperationSchema = z
  .object({
    operation_id: z.string().regex(/^[a-z][a-z0-9_:.-]{0,159}$/),
    phase: BlueprintExecutionPhaseSchema,
    action: z.enum(['create', 'update', 'reorder', 'send']),
    resource: z.enum([
      'role',
      'category',
      'channel',
      'role_order',
      'channel_order',
      'guild',
      'welcome_screen',
      'onboarding',
      'automod_rule',
      'publication',
    ]),
    key: SymbolKey,
    summary: z.string().min(1).max(240),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const BlueprintBlockerSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(500),
    resource: z.string().min(1).max(160).nullable(),
    recovery_hint: z.string().min(1).max(500),
  })
  .strict();

export const BlueprintBindingsSchema = z
  .object({
    roles: z.record(SymbolKey, Snowflake),
    categories: z.record(SymbolKey, Snowflake),
    channels: z.record(SymbolKey, Snowflake),
    automod_rules: z.record(SymbolKey, Snowflake),
    publications: z.record(SymbolKey, Snowflake),
  })
  .strict();

export const BlueprintPlanTargetSchema = z
  .object({
    guild_id: GuildId,
    bot_id: UserId,
  })
  .strict();

export const GuildBlueprintPlanPayloadSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_plan.v1'),
    policy_version: z.literal('safe-reconcile.v1'),
    target: BlueprintPlanTargetSchema,
    blueprint_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    blueprint: GuildBlueprintSchema,
    initial_snapshot_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    initial_bindings: BlueprintBindingsSchema,
    initial_operations: z.array(BlueprintOperationSchema).max(128),
    policy: z
      .object({
        deletions: z.literal(false),
        ambiguous_matches: z.literal('block'),
        unbound_drift: z.literal('block'),
        auto_grant_bot_permissions: z.literal(false),
        managed_roles: z.literal('immutable'),
        publication_idempotency: z.literal('marker_and_discord_nonce'),
      })
      .strict(),
  })
  .strict();

export const BlueprintPlanSummarySchema = z
  .object({
    total_operations: z.number().int().nonnegative(),
    create_operations: z.number().int().nonnegative(),
    update_operations: z.number().int().nonnegative(),
    reorder_operations: z.number().int().nonnegative(),
    send_operations: z.number().int().nonnegative(),
    high_risk_operations: z.number().int().nonnegative(),
    by_phase: z.record(BlueprintExecutionPhaseSchema, z.number().int().nonnegative()),
  })
  .strict();

export const BlueprintCheckpointSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_checkpoint.v1'),
    plan_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    blueprint_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    target: BlueprintPlanTargetSchema,
    version: z.number().int().nonnegative(),
    status: z.enum(['applying', 'partial', 'complete']),
    bindings: BlueprintBindingsSchema,
    completed_operation_ids: z.array(z.string()).max(256),
    last_error: z
      .object({
        operation_id: z.string(),
        code: z.string(),
        retriable: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BlueprintExecutionPhase = z.infer<typeof BlueprintExecutionPhaseSchema>;
export type BlueprintOperation = z.infer<typeof BlueprintOperationSchema>;
export type BlueprintBlocker = z.infer<typeof BlueprintBlockerSchema>;
export type BlueprintBindings = z.infer<typeof BlueprintBindingsSchema>;
export type BlueprintPlanTarget = z.infer<typeof BlueprintPlanTargetSchema>;
export type GuildBlueprintPlanPayload = z.infer<typeof GuildBlueprintPlanPayloadSchema>;
export type BlueprintPlanSummary = z.infer<typeof BlueprintPlanSummarySchema>;
export type BlueprintCheckpoint = z.infer<typeof BlueprintCheckpointSchema>;

export function emptyBlueprintBindings(): BlueprintBindings {
  return {
    roles: {},
    categories: {},
    channels: {},
    automod_rules: {},
    publications: {},
  };
}
