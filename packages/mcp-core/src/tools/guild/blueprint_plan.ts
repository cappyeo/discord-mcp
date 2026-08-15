import { container } from '@sapphire/pieces';
import { z } from 'zod';
import { verifyExpectedBotIdentity } from '../../identity-lock.js';
import { resolveBlueprintPlanTarget } from '../../middleware/blueprint-plan-target.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import { TemplateCode } from '../templates/_lib/template.js';
import { RecommendationCandidateSchema } from '../templates/recommend.js';
import { blueprintBoundaryBlockers } from './_lib/blueprint.boundary.js';
import {
  BlueprintBlockerSchema,
  BlueprintOperationSchema,
  BlueprintPlanSummarySchema,
  BlueprintPlanTargetSchema,
  GuildBlueprintPlanPayloadSchema,
} from './_lib/blueprint.execution.schema.js';
import { GuildBlueprintSchema } from './_lib/blueprint.js';
import { saveBlueprintPlanReference } from './_lib/blueprint.plan-reference-store.js';
import { encodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import {
  reconcileGuildBlueprint,
  summarizeBlueprintOperations,
} from './_lib/blueprint.reconcile.js';
import { compileBlueprintRequest } from './_lib/blueprint.request.js';
import { resolveBlueprintStateDirectory } from './_lib/blueprint.state-path.js';
import { readBlueprintTargetSnapshot } from './_lib/blueprint.target.js';
import { appendBlueprintTextReceipt } from './_lib/blueprint.text-receipt.js';
import { blueprintSigningSecret, blueprintTrustBoundary } from './_lib/blueprint.trust.js';

const BotPermissionsSchema = z
  .object({
    administrator: z.boolean(),
    missing: z.array(z.string()),
    top_role_id: z.string().nullable(),
    top_role_position: z.number().int().nonnegative(),
  })
  .strict();

const PlanVerificationSchema = z
  .object({
    catalog_records: z.number().int().nonnegative(),
    candidates_inspected: z.number().int().nonnegative(),
    template_rest_requests: z.number().int().nonnegative(),
    template_cache_hits: z.number().int().nonnegative(),
    templates_verified: z.number().int().nonnegative(),
    blueprint_validation: z.enum(['not_run', 'passed']),
    target_readback: z.enum(['not_run', 'passed']),
  })
  .strict();

function emptyVerification() {
  return {
    catalog_records: 0,
    candidates_inspected: 0,
    template_rest_requests: 0,
    template_cache_hits: 0,
    templates_verified: 0,
    blueprint_validation: 'not_run' as const,
    target_readback: 'not_run' as const,
  };
}

export default defineTool({
  name: 'guild_blueprint_plan',
  category: 'guild',
  description: [
    '**Purpose**: Build, create, or design a complete Discord server from one natural-language request and return a target-bound execution preview without mutating Discord. It compiles a safe blueprint, verifies the exact caller-owned bot and allowlisted guild, reads live state, blocks ambiguous resources or missing permissions, and returns a compact local plan reference for `guild_blueprint_apply`.',
    '',
    '**When to use**: This is the required first step for an unqualified request to build, design, create, dựng, or tạo a gaming or community server. Call it immediately with the original request instead of asking which kind of server the user means or manually chaining template, role, channel, onboarding, AutoMod, and Components V2 tools. In this Discord integration, unqualified “server” means a Discord guild—not a VPS, hardware, or game-hosting machine—unless the user explicitly says otherwise. Examples include “build a professional gaming server” and “dựng cho tôi một server gaming chuyên nghiệp”.',
    '',
    '**Safety**: This tool makes no Discord mutation and writes no checkpoint. It may persist private, authenticated deterministic plan material locally so a caller can resume with `plan_ref`; the raw plan token is not persisted. It resolves the bot only from `DISCORD_EXPECTED_BOT_ID` and resolves an omitted guild only from `DISCORD_DEFAULT_GUILD_ID` or exactly one `ALLOWED_GUILDS` entry; multiple possible guilds fail closed. Explicit values are never overwritten and must match the locked profile. Existing unrelated resources are preserved; duplicate or mismatched unbound resources block the plan. The opaque token is authenticated to this bot profile; the displayed approval ID is not standalone authorization.',
    '',
    '**Returns**: Verified source evidence, the complete blueprint, exact bot/guild binding, dry-run operations and risks, blockers, and a local `plan_ref` (or a legacy compressed `plan_token`) accepted by the confirmed resumable apply tool.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.optional().describe(
      'Optional explicit target guild; omit only when the selected profile has a default or exactly one allowlisted guild',
    ),
    expected_bot_id: UserId.optional().describe(
      'Optional exact caller-owned bot ID; omit to use DISCORD_EXPECTED_BOT_ID from the selected profile',
    ),
    request: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe('Natural-language description of the Discord server to build'),
    preferred_primary_code: TemplateCode.optional().describe(
      'Optional public template code to prefer only when relevant and live-verified safe',
    ),
  },
  outputSchema: {
    status: z.enum(['ready', 'already_current', 'blocked', 'no_match']),
    request: z.string(),
    source: z
      .object({
        catalog_version: z.string(),
        primary: RecommendationCandidateSchema.nullable(),
        inspirations: z.array(RecommendationCandidateSchema).max(3),
        permission_policy: z.literal('discard_source_and_regenerate'),
      })
      .nullable(),
    target: BlueprintPlanTargetSchema.nullable(),
    blueprint_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    blueprint: GuildBlueprintSchema.nullable(),
    snapshot_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    plan_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    approval_id: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    plan_token: z
      .string()
      .max(65_536)
      .nullable()
      .describe('Legacy portable apply credential; prefer plan_ref when it is available'),
    plan_ref: z
      .string()
      .regex(/^dmbpr1\.[a-f0-9]{64}$/)
      .nullable()
      .describe('Preferred caller-local apply reference; null only when local persistence failed'),
    summary: BlueprintPlanSummarySchema.nullable(),
    operations: z.array(BlueprintOperationSchema).max(128),
    bot_permissions: BotPermissionsSchema.nullable(),
    blockers: z.array(BlueprintBlockerSchema),
    warnings: z.array(z.string()),
    verification: PlanVerificationSchema,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const resolvedTarget = resolveBlueprintPlanTarget(
      container.config,
      args.guild_id,
      args.expected_bot_id,
    );
    const guildId = resolvedTarget.guild_id;
    const expectedBotId = resolvedTarget.expected_bot_id;
    const staticBlockers = blueprintBoundaryBlockers(container.config, guildId, expectedBotId);
    if (staticBlockers.length > 0) {
      return dualResult({
        text: `Blueprint plan blocked before Discord access: ${staticBlockers.map((item) => item.code).join(', ')}. No guild was changed.`,
        data: {
          status: 'blocked' as const,
          request: args.request,
          source: null,
          target: null,
          blueprint_id: null,
          blueprint: null,
          snapshot_id: null,
          plan_id: null,
          approval_id: null,
          plan_token: null,
          plan_ref: null,
          summary: null,
          operations: [],
          bot_permissions: null,
          blockers: staticBlockers,
          warnings: [],
          verification: emptyVerification(),
        },
      });
    }
    if (guildId === undefined || expectedBotId === undefined) {
      throw new Error('Blueprint target resolution passed its boundary without a complete target.');
    }

    try {
      await verifyExpectedBotIdentity(container.rest, expectedBotId, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const identityBlocker = {
        code: 'EXPECTED_BOT_MISMATCH',
        message: 'The active Discord token did not verify as the explicitly selected bot.',
        resource: `bot:${expectedBotId}`,
        recovery_hint: 'Select the correct caller-owned bot profile and restart before retrying.',
      };
      return dualResult({
        text: 'Blueprint plan blocked by the exact bot identity lock. No guild was read or changed.',
        data: {
          status: 'blocked' as const,
          request: args.request,
          source: null,
          target: null,
          blueprint_id: null,
          blueprint: null,
          snapshot_id: null,
          plan_id: null,
          approval_id: null,
          plan_token: null,
          plan_ref: null,
          summary: null,
          operations: [],
          bot_permissions: null,
          blockers: [identityBlocker],
          warnings: [],
          verification: emptyVerification(),
        },
      });
    }

    const compiled = await compileBlueprintRequest(args, ctx.signal);
    const recommendation = compiled.recommendation;
    const source = {
      catalog_version: recommendation.catalog_version,
      primary: recommendation.primary,
      inspirations: recommendation.inspirations,
      permission_policy: 'discard_source_and_regenerate' as const,
    };
    const verificationBase = {
      catalog_records: recommendation.verification.catalog_records,
      candidates_inspected: recommendation.verification.candidates_inspected,
      template_rest_requests: recommendation.verification.rest_requests,
      template_cache_hits: recommendation.verification.cache_hits,
      templates_verified: recommendation.verification.rest_verified,
    };
    if (compiled.blueprint === null || compiled.blueprint_id === null) {
      return dualResult({
        text: `Blueprint plan is ${recommendation.status}: no verified primary template was available, so no target guild inventory was read and no plan was emitted.`,
        data: {
          status: 'no_match' as const,
          request: args.request,
          source,
          target: null,
          blueprint_id: null,
          blueprint: null,
          snapshot_id: null,
          plan_id: null,
          approval_id: null,
          plan_token: null,
          plan_ref: null,
          summary: null,
          operations: [],
          bot_permissions: null,
          blockers: [],
          warnings: ['A verified primary template is required before target planning.'],
          verification: {
            ...verificationBase,
            blueprint_validation: 'not_run' as const,
            target_readback: 'not_run' as const,
          },
        },
      });
    }

    const snapshot = await readBlueprintTargetSnapshot(
      container.rest,
      guildId,
      expectedBotId,
      compiled.blueprint,
      undefined,
      ctx.signal,
    );
    const reconciled = reconcileGuildBlueprint(compiled.blueprint_id, compiled.blueprint, snapshot);
    const summary = summarizeBlueprintOperations(reconciled.operations);
    const warnings = [
      'No Discord resource was changed; this is an exact target-bound dry-run.',
      'Keep the caller-local plan reference and legacy plan token inside the same trusted caller boundary; neither bypasses the exact bot/guild locks or explicit confirmation.',
      ...reconciled.warnings,
    ];
    if (compiled.source_permission_risks.length > 0) {
      warnings.push(
        `Source templates exposed ${compiled.source_permission_risks.length} risky permission class(es); all source permissions and overwrites were discarded.`,
      );
    }
    const target = { guild_id: guildId, bot_id: expectedBotId };
    if (reconciled.blockers.length > 0) {
      return dualResult({
        text: `Blueprint dry-run found ${reconciled.blockers.length} blocker(s) and scheduled no apply credential. No guild was changed.`,
        data: {
          status: 'blocked' as const,
          request: args.request,
          source,
          target,
          blueprint_id: compiled.blueprint_id,
          blueprint: compiled.blueprint,
          snapshot_id: reconciled.snapshot_id,
          plan_id: null,
          approval_id: null,
          plan_token: null,
          plan_ref: null,
          summary,
          operations: reconciled.operations,
          bot_permissions: reconciled.bot_permissions,
          blockers: reconciled.blockers,
          warnings,
          verification: {
            ...verificationBase,
            blueprint_validation: 'passed' as const,
            target_readback: 'passed' as const,
          },
        },
      });
    }

    const payload = GuildBlueprintPlanPayloadSchema.parse({
      schema_version: 'guild_blueprint_plan.v1',
      policy_version: 'safe-reconcile.v1',
      target,
      blueprint_id: compiled.blueprint_id,
      blueprint: compiled.blueprint,
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
    });
    const trustBoundary = blueprintTrustBoundary();
    const encoded = encodeBlueprintPlan(
      payload,
      blueprintSigningSecret(container.config, trustBoundary),
    );
    const status = reconciled.operations.length === 0 ? 'already_current' : 'ready';
    const planRefWarnings: string[] = [];
    let planRef: string | null = null;
    try {
      planRef = await saveBlueprintPlanReference({
        stateDirectory: resolveBlueprintStateDirectory(container.config),
        planId: encoded.plan_id,
        payload,
        signingSecret: blueprintSigningSecret(container.config, trustBoundary),
      });
    } catch {
      planRefWarnings.push(
        'The private local plan reference could not be persisted; use the legacy plan_token in this trusted caller session.',
      );
    }
    const data = {
      status,
      request: args.request,
      source,
      target,
      blueprint_id: compiled.blueprint_id,
      blueprint: compiled.blueprint,
      snapshot_id: reconciled.snapshot_id,
      plan_id: encoded.plan_id,
      approval_id: encoded.approval_id,
      plan_token: encoded.plan_token,
      plan_ref: planRef,
      summary,
      operations: reconciled.operations,
      bot_permissions: reconciled.bot_permissions,
      blockers: [],
      warnings: [...warnings, ...planRefWarnings],
      verification: {
        ...verificationBase,
        blueprint_validation: 'passed' as const,
        target_readback: 'passed' as const,
      },
    };
    const text =
      status === 'already_current'
        ? `Blueprint ${compiled.blueprint_id} already matches the locked target; no Discord mutation is needed.`
        : `Blueprint dry-run is ready for bot ${expectedBotId} in guild ${guildId}: ${summary.total_operations} operation(s), including ${summary.high_risk_operations} explicitly confirmed high-risk replacement(s). No guild was changed.`;
    return dualResult({
      text: appendBlueprintTextReceipt(text, 'plan', {
        status,
        target,
        plan_id: encoded.plan_id,
        blueprint_id: compiled.blueprint_id,
        approval_id: encoded.approval_id,
        plan_ref: planRef,
      }),
      data,
    });
  },
});
