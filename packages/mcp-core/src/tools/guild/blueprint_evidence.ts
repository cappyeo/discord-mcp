import { container } from '@sapphire/pieces';
import { z } from 'zod';
import { verifyExpectedBotIdentity } from '../../identity-lock.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import {
  type GuildBlueprintActivityEvidence,
  GuildBlueprintObservedEvidenceSchema,
  GuildBlueprintPlanInvariantsSchema,
} from './_lib/blueprint.activity-evidence.js';
import { blueprintBoundaryBlockers } from './_lib/blueprint.boundary.js';
import {
  BlueprintCheckpointStore,
  BlueprintCheckpointStoreError,
} from './_lib/blueprint.checkpoint-store.js';
import {
  type BlueprintBlocker,
  BlueprintBlockerSchema,
  type BlueprintOperation,
  BlueprintOperationSchema,
  BlueprintPlanTargetSchema,
} from './_lib/blueprint.execution.schema.js';
import { reconcileGuildBlueprint } from './_lib/blueprint.reconcile.js';
import { resolveBlueprintStateDirectory } from './_lib/blueprint.state-path.js';
import {
  type BlueprintTargetSnapshot,
  readBlueprintTargetSnapshot,
} from './_lib/blueprint.target.js';
import { blueprintSigningSecret } from './_lib/blueprint.trust.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const CurrentSnapshotSchema = z
  .object({
    snapshot_id: Digest,
    guild: z
      .object({
        id: GuildId,
        name: z.string(),
        features: z.array(z.string()),
      })
      .strict(),
    bot_id: UserId,
    resources: z
      .object({
        roles: z.number().int().nonnegative(),
        categories: z.number().int().nonnegative(),
        channels: z.number().int().nonnegative(),
        automod_rules: z.number().int().nonnegative(),
        recent_messages: z.number().int().nonnegative(),
      })
      .strict(),
    onboarding_enabled: z.boolean().nullable(),
    welcome_screen_configured: z.boolean().nullable(),
  })
  .strict();

const PublicEvidenceRecordSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_activity_evidence.v1'),
    recorded_at: z.string().datetime({ offset: true }),
    initial_operation_count: z.number().int().nonnegative().max(128),
    plan_invariants: GuildBlueprintPlanInvariantsSchema,
    observed: GuildBlueprintObservedEvidenceSchema,
  })
  .strict();

type CurrentSnapshot = z.infer<typeof CurrentSnapshotSchema>;

interface EvidenceVerification {
  readonly identity_verified: boolean;
  readonly guild_verified: boolean;
  readonly readback: 'match' | 'drift' | 'not_run';
  readonly snapshot_unchanged: boolean | null;
  readonly current_snapshot: CurrentSnapshot | null;
  readonly remaining_operations: readonly BlueprintOperation[];
  readonly blockers: readonly BlueprintBlocker[];
  readonly warnings: readonly string[];
}

function blocker(code: string, message: string, resource: string | null, recoveryHint: string) {
  return { code, message, resource, recovery_hint: recoveryHint };
}

function emptyVerification(): EvidenceVerification {
  return {
    identity_verified: false,
    guild_verified: false,
    readback: 'not_run' as const,
    snapshot_unchanged: null,
    current_snapshot: null,
    remaining_operations: [],
    blockers: [],
    warnings: [],
  };
}

function publicRecord(evidence: GuildBlueprintActivityEvidence) {
  return {
    schema_version: evidence.schema_version,
    recorded_at: evidence.recorded_at,
    plan_invariants: evidence.plan_invariants,
    observed: evidence.observed,
    initial_operation_count: evidence.initial_operation_count,
  };
}

function currentSnapshot(snapshotId: string, snapshot: BlueprintTargetSnapshot): CurrentSnapshot {
  return CurrentSnapshotSchema.parse({
    snapshot_id: snapshotId,
    guild: {
      id: snapshot.guild.id,
      name: snapshot.guild.name,
      features: [...snapshot.guild.features],
    },
    bot_id: snapshot.bot.user.id,
    resources: {
      roles: snapshot.roles.length,
      categories: snapshot.channels.filter((channel) => channel.type === 4).length,
      channels: snapshot.channels.filter((channel) => channel.type !== 4).length,
      automod_rules: snapshot.automod_rules.length,
      recent_messages: Object.values(snapshot.recent_messages).reduce(
        (count, messages) => count + messages.length,
        0,
      ),
    },
    onboarding_enabled: snapshot.onboarding?.enabled ?? null,
    welcome_screen_configured: snapshot.welcome_screen !== null,
  });
}

export default defineTool({
  name: 'guild_blueprint_evidence',
  category: 'guild',
  description: [
    '**Purpose**: Read the immutable Activity Evidence for one completed blueprint plan and verify its current Discord state without changing the guild.',
    '',
    '**When to use**: Use after `guild_blueprint_apply` reports completion, or later to prove whether the target still matches that approved blueprint.',
    '',
    '**Safety**: The explicit caller-owned bot and allowlisted guild are checked before Discord access. The local proof is authenticated to the active caller boundary; missing, tampered, cross-caller, or wrong-target records fail closed. This tool never acquires locks, writes checkpoints, or mutates Discord.',
    '',
    '**Returns**: A public proof summary (never the persisted full blueprint), current target inventory, whether the immutable completion snapshot is unchanged, remaining safe reconciliation operations, and structured blueprint drift blockers.',
  ].join('\n'),
  preconditions: ['explicit_guild_required'] as const,
  inputSchema: {
    guild_id: GuildId.describe('Explicit target guild; configured defaults are never accepted'),
    expected_bot_id: UserId.describe('Exact caller-owned bot ID locked by the selected profile'),
    plan_id: Digest.describe('Digest ID returned by the approved blueprint plan'),
  },
  outputSchema: {
    status: z.enum(['verified', 'drifted', 'not_found', 'blocked']),
    plan_id: Digest,
    blueprint_id: Digest.nullable(),
    evidence_id: Digest.nullable(),
    target: BlueprintPlanTargetSchema,
    record: PublicEvidenceRecordSchema.nullable(),
    verification: z
      .object({
        identity_verified: z.boolean(),
        guild_verified: z.boolean(),
        readback: z.enum(['match', 'drift', 'not_run']),
        snapshot_unchanged: z.boolean().nullable(),
        current_snapshot: CurrentSnapshotSchema.nullable(),
        remaining_operations: z.array(BlueprintOperationSchema).max(128),
        blockers: z.array(BlueprintBlockerSchema),
        warnings: z.array(z.string()),
      })
      .strict(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const target = { guild_id: args.guild_id, bot_id: args.expected_bot_id };
    const respond = (
      status: 'verified' | 'drifted' | 'not_found' | 'blocked',
      blueprintId: string | null,
      evidenceId: string | null,
      record: ReturnType<typeof publicRecord> | null,
      verification: EvidenceVerification,
      text: string,
    ) =>
      dualResult({
        text,
        data: {
          status,
          plan_id: args.plan_id,
          blueprint_id: blueprintId,
          evidence_id: evidenceId,
          target,
          record,
          verification,
        },
      });

    const boundaryBlockers = blueprintBoundaryBlockers(
      container.config,
      args.guild_id,
      args.expected_bot_id,
    );
    if (boundaryBlockers.length > 0) {
      return respond(
        'blocked',
        null,
        null,
        null,
        { ...emptyVerification(), blockers: boundaryBlockers },
        'Blueprint Activity Evidence is blocked by the caller profile boundary. No local proof or Discord state was read.',
      );
    }

    const store = new BlueprintCheckpointStore({
      stateDirectory: resolveBlueprintStateDirectory(container.config),
      planId: args.plan_id,
      signingSecret: blueprintSigningSecret(container.config),
    });
    let evidence: GuildBlueprintActivityEvidence | null;
    try {
      evidence = await store.loadEvidence();
    } catch (error) {
      const code =
        error instanceof BlueprintCheckpointStoreError && error.code === 'EVIDENCE_IO'
          ? 'ACTIVITY_EVIDENCE_UNAVAILABLE'
          : 'ACTIVITY_EVIDENCE_UNVERIFIABLE';
      return respond(
        'blocked',
        null,
        null,
        null,
        {
          ...emptyVerification(),
          blockers: [
            blocker(
              code,
              'The local Activity Evidence record could not be safely verified for this caller.',
              `plan:${args.plan_id}`,
              'Create and complete a fresh target-bound blueprint plan before relying on its evidence.',
            ),
          ],
        },
        'Blueprint Activity Evidence is blocked because its local proof is unavailable or cannot be authenticated. No Discord state was read.',
      );
    }
    if (evidence === null) {
      return respond(
        'not_found',
        null,
        null,
        null,
        emptyVerification(),
        'No immutable Activity Evidence exists for this plan in the active caller profile. No Discord state was read.',
      );
    }
    if (
      evidence.target.guild_id !== args.guild_id ||
      evidence.target.bot_id !== args.expected_bot_id
    ) {
      return respond(
        'blocked',
        null,
        null,
        null,
        {
          ...emptyVerification(),
          blockers: [
            blocker(
              'EVIDENCE_TARGET_MISMATCH',
              'The authenticated Activity Evidence belongs to a different bot or guild target.',
              `plan:${args.plan_id}`,
              'Use the exact target recorded by the approved plan; never substitute IDs.',
            ),
          ],
        },
        'Blueprint Activity Evidence is bound to a different explicit target. No Discord state was read.',
      );
    }

    const record = publicRecord(evidence);
    try {
      await verifyExpectedBotIdentity(container.rest, args.expected_bot_id, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return respond(
        'blocked',
        evidence.blueprint_id,
        evidence.evidence_id,
        record,
        {
          ...emptyVerification(),
          blockers: [
            blocker(
              'EXPECTED_BOT_MISMATCH',
              'The active Discord token did not verify as the explicitly selected bot.',
              `bot:${args.expected_bot_id}`,
              'Select the correct caller-owned bot profile and restart before retrying.',
            ),
          ],
        },
        'Blueprint Activity Evidence is blocked by the exact bot identity lock. No guild state was read.',
      );
    }

    try {
      const snapshot = await readBlueprintTargetSnapshot(
        container.rest,
        args.guild_id,
        args.expected_bot_id,
        evidence.blueprint,
        evidence.observed.bindings,
        ctx.signal,
      );
      const reconciled = reconcileGuildBlueprint(
        evidence.blueprint_id,
        evidence.blueprint,
        snapshot,
        evidence.observed.bindings,
      );
      const snapshotUnchanged = reconciled.snapshot_id === evidence.observed.final_snapshot_id;
      const blueprintMatches =
        reconciled.operations.length === 0 && reconciled.blockers.length === 0;
      const verification = {
        identity_verified: true,
        guild_verified: true,
        readback: blueprintMatches ? ('match' as const) : ('drift' as const),
        snapshot_unchanged: snapshotUnchanged,
        current_snapshot: currentSnapshot(reconciled.snapshot_id, snapshot),
        remaining_operations: reconciled.operations,
        blockers: reconciled.blockers,
        warnings: snapshotUnchanged
          ? reconciled.warnings
          : [
              'The current target snapshot differs from the immutable completion snapshot; blueprint conformance was evaluated independently and no mutation was attempted.',
              ...reconciled.warnings,
            ],
      };
      return respond(
        blueprintMatches ? 'verified' : 'drifted',
        evidence.blueprint_id,
        evidence.evidence_id,
        record,
        verification,
        blueprintMatches
          ? snapshotUnchanged
            ? 'Blueprint Activity Evidence is verified against the unchanged locked Discord target. No guild was changed.'
            : 'The current locked Discord target still conforms to the evidenced blueprint, but its whole-guild snapshot has changed. No guild was changed.'
          : 'Blueprint Activity Evidence is valid, but the current Discord target has drifted. No guild was changed.',
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return respond(
        'blocked',
        evidence.blueprint_id,
        evidence.evidence_id,
        record,
        {
          ...emptyVerification(),
          identity_verified: true,
          blockers: [
            blocker(
              'DISCORD_READBACK_UNAVAILABLE',
              'The current guild state could not be safely read and verified.',
              `guild:${args.guild_id}`,
              'Check the selected bot access and Discord availability, then retry this read-only verification.',
            ),
          ],
        },
        'Blueprint Activity Evidence could not complete a safe Discord readback. No guild was changed.',
      );
    }
  },
});
