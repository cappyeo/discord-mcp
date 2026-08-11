import { createHash } from 'node:crypto';
import { DiscordAPIError, HTTPError, RateLimitError } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { z } from 'zod';
import { verifyExpectedBotIdentity } from '../../identity-lock.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import {
  BlueprintExecutionError,
  executeBlueprintOperation,
} from './_lib/blueprint.apply-executor.js';
import { blueprintBoundaryBlockers } from './_lib/blueprint.boundary.js';
import {
  BlueprintCheckpointStore,
  BlueprintCheckpointStoreError,
} from './_lib/blueprint.checkpoint-store.js';
import {
  type BlueprintBindings,
  BlueprintBindingsSchema,
  BlueprintBlockerSchema,
  type BlueprintCheckpoint,
  BlueprintPlanTargetSchema,
  emptyBlueprintBindings,
  type GuildBlueprintPlanPayload,
} from './_lib/blueprint.execution.schema.js';
import { BlueprintPlanTokenError, decodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import { reconcileGuildBlueprint } from './_lib/blueprint.reconcile.js';
import { resolveBlueprintStateDirectory } from './_lib/blueprint.state-path.js';
import { readBlueprintTargetSnapshot } from './_lib/blueprint.target.js';
import { blueprintSigningSecret } from './_lib/blueprint.trust.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const ApplyErrorSchema = z
  .object({
    operation_id: z.string().nullable(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    retriable: z.boolean(),
    status: z.number().int().min(100).max(599).nullable(),
  })
  .strict();

const ApplyAttemptSchema = z
  .object({
    operation_id: z.string(),
    status: z.enum(['completed', 'failed']),
    resource_id: z.string().nullable(),
    error_code: z.string().nullable(),
  })
  .strict();

type ApplyStatus = 'complete' | 'already_current' | 'partial' | 'blocked' | 'busy' | 'stale';
type NextAction = 'done' | 'resume' | 'replan' | 'fix_configuration';

interface SafeApplyError {
  readonly operation_id: string | null;
  readonly code: string;
  readonly retriable: boolean;
  readonly status: number | null;
}

interface ApplyAttempt {
  readonly operation_id: string;
  readonly status: 'completed' | 'failed';
  readonly resource_id: string | null;
  readonly error_code: string | null;
}

interface ApplyData {
  readonly status: ApplyStatus;
  readonly plan_id: string | null;
  readonly blueprint_id: string | null;
  readonly target: { readonly guild_id: string; readonly bot_id: string };
  readonly progress: {
    readonly initial_planned: number;
    readonly planned_this_call: number;
    readonly attempted_this_call: number;
    readonly completed_total: number;
    readonly remaining: number;
    readonly checkpoint_version: number | null;
  };
  readonly attempts: readonly ApplyAttempt[];
  readonly blockers: readonly {
    readonly code: string;
    readonly message: string;
    readonly resource: string | null;
    readonly recovery_hint: string;
  }[];
  readonly error: SafeApplyError | null;
  readonly evidence: {
    readonly identity_verified: boolean;
    readonly guild_verified: boolean;
    readonly readback: 'match' | 'drift' | 'not_run';
    readonly snapshot_id_before: string | null;
    readonly snapshot_id_after: string | null;
    readonly checkpoint_persisted: boolean;
    readonly bindings: BlueprintBindings;
    readonly completed_operation_ids: readonly string[];
  };
  readonly next_action: NextAction;
  readonly warnings: readonly string[];
}

function cloneBindings(bindings: BlueprintBindings): BlueprintBindings {
  return {
    roles: { ...bindings.roles },
    categories: { ...bindings.categories },
    channels: { ...bindings.channels },
    automod_rules: { ...bindings.automod_rules },
    publications: { ...bindings.publications },
  };
}

function targetLockId(guildId: string): string {
  return `sha256:${createHash('sha256')
    .update(`discord-mcp-blueprint-target-lock.v1\0${guildId}`)
    .digest('hex')}`;
}

function blocker(code: string, message: string, resource: string | null, recoveryHint: string) {
  return { code, message, resource, recovery_hint: recoveryHint };
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function safeApplyError(error: unknown, operationId: string | null): SafeApplyError {
  const status = errorStatus(error);
  if (error instanceof BlueprintExecutionError) {
    return {
      operation_id: operationId,
      code: error.code,
      retriable: error.code === 'CANCELLED' || error.code === 'APPLY_LOCK_LOST',
      status,
    };
  }
  if (error instanceof BlueprintCheckpointStoreError) {
    return {
      operation_id: operationId,
      code: error.code,
      retriable: error.code === 'CHECKPOINT_IO',
      status: null,
    };
  }
  if (error instanceof RateLimitError) {
    return {
      operation_id: operationId,
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      status: 429,
    };
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    return {
      operation_id: operationId,
      code: status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_API_ERROR',
      retriable: status === 429 || (status !== null && status >= 500),
      status,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { operation_id: operationId, code: 'CANCELLED', retriable: true, status: null };
  }
  return { operation_id: operationId, code: 'APPLY_FAILED', retriable: false, status };
}

function checkpoint(
  planId: string,
  plan: GuildBlueprintPlanPayload,
  version: number,
  status: BlueprintCheckpoint['status'],
  bindings: BlueprintBindings,
  completedOperationIds: readonly string[],
  lastError: BlueprintCheckpoint['last_error'],
): BlueprintCheckpoint {
  return {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id: planId,
    blueprint_id: plan.blueprint_id,
    target: plan.target,
    version,
    status,
    bindings: cloneBindings(bindings),
    completed_operation_ids: [...new Set(completedOperationIds)],
    last_error: lastError,
  };
}

function response(text: string, data: ApplyData) {
  return dualResult({ text, data });
}

export default defineTool({
  name: 'guild_blueprint_apply',
  category: 'guild',
  description: [
    '**Purpose**: Apply a previously previewed `guild_blueprint_plan` safely to one explicit guild using the exact caller-owned bot. The operation graph is checkpointed locally after every successful mutation and reconciled against Discord before every resume.',
    '',
    '**When to use**: Call only after presenting the plan summary and receiving approval for its `approval_id`. Pass the unchanged `plan_token`, exact guild/bot IDs, `__confirm:true`, and run with `MCP_DRY_RUN=false`.',
    '',
    '**Safety**: The tool re-verifies bot identity, guild allowlist, plan target, approval ID, live permissions, role hierarchy, drift, and a guild-wide apply lock before writing. It never deletes resources, never grants its own permissions, and stops on ambiguity or mismatched bound resources.',
    '',
    '**Resume**: A partial result is safe to call again with the same inputs. Discord readback plus a local append-only checkpoint prevents duplicate roles, channels, AutoMod rules, and Components V2 publications.',
    '',
    '**Returns**: Bounded progress, safe error codes, remaining work, bindings, and final Discord readback evidence. The plan token is never echoed.',
  ].join('\n'),
  preconditions: ['explicit_guild_required', 'confirm_required'] as const,
  inputSchema: {
    guild_id: GuildId.describe('Explicit target guild; configured defaults are never accepted'),
    expected_bot_id: UserId.describe('Exact caller-owned bot ID locked by the selected profile'),
    plan_token: z
      .string()
      .min(1)
      .max(65_536)
      .describe('Opaque token returned by guild_blueprint_plan'),
    approval_id: Digest.describe('Approval ID shown by guild_blueprint_plan'),
    operation_budget: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe(
        'Maximum Discord mutations attempted in this call; resume with the same plan if needed',
      ),
  },
  outputSchema: {
    status: z.enum(['complete', 'already_current', 'partial', 'blocked', 'busy', 'stale']),
    plan_id: Digest.nullable(),
    blueprint_id: Digest.nullable(),
    target: BlueprintPlanTargetSchema,
    progress: z
      .object({
        initial_planned: z.number().int().nonnegative(),
        planned_this_call: z.number().int().nonnegative(),
        attempted_this_call: z.number().int().nonnegative(),
        completed_total: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        checkpoint_version: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    attempts: z.array(ApplyAttemptSchema).max(50),
    blockers: z.array(BlueprintBlockerSchema),
    error: ApplyErrorSchema.nullable(),
    evidence: z
      .object({
        identity_verified: z.boolean(),
        guild_verified: z.boolean(),
        readback: z.enum(['match', 'drift', 'not_run']),
        snapshot_id_before: Digest.nullable(),
        snapshot_id_after: Digest.nullable(),
        checkpoint_persisted: z.boolean(),
        bindings: BlueprintBindingsSchema,
        completed_operation_ids: z.array(z.string()).max(256),
      })
      .strict(),
    next_action: z.enum(['done', 'resume', 'replan', 'fix_configuration']),
    warnings: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const target = { guild_id: args.guild_id, bot_id: args.expected_bot_id };
    const emptyProgress = {
      initial_planned: 0,
      planned_this_call: 0,
      attempted_this_call: 0,
      completed_total: 0,
      remaining: 0,
      checkpoint_version: null,
    };
    const emptyEvidence = {
      identity_verified: false,
      guild_verified: false,
      readback: 'not_run' as const,
      snapshot_id_before: null,
      snapshot_id_after: null,
      checkpoint_persisted: false,
      bindings: emptyBlueprintBindings(),
      completed_operation_ids: [],
    };

    let decoded: ReturnType<typeof decodeBlueprintPlan>;
    const signingSecret = blueprintSigningSecret(container.config);
    try {
      decoded = decodeBlueprintPlan(args.plan_token, signingSecret);
    } catch (error) {
      const code = error instanceof BlueprintPlanTokenError ? error.code : 'PLAN_TOKEN_INVALID';
      return response(
        'Blueprint apply blocked: the plan token is invalid. No Discord access occurred.',
        {
          status: 'blocked',
          plan_id: null,
          blueprint_id: null,
          target,
          progress: emptyProgress,
          attempts: [],
          blockers: [
            blocker(
              code,
              'The supplied plan token could not be verified.',
              null,
              'Create a fresh preview with guild_blueprint_plan.',
            ),
          ],
          error: null,
          evidence: emptyEvidence,
          next_action: 'replan',
          warnings: ['The invalid plan token was not echoed or persisted.'],
        },
      );
    }

    const plan = decoded.payload;
    const baseProgress = {
      ...emptyProgress,
      initial_planned: plan.initial_operations.length,
      remaining: plan.initial_operations.length,
    };
    if (plan.target.guild_id !== args.guild_id || plan.target.bot_id !== args.expected_bot_id) {
      return response(
        'Blueprint apply blocked: the token target differs from the explicit target.',
        {
          status: 'blocked',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: baseProgress,
          attempts: [],
          blockers: [
            blocker(
              'PLAN_TARGET_MISMATCH',
              'The plan is bound to a different bot or guild.',
              null,
              'Use the exact target returned by guild_blueprint_plan; never substitute IDs.',
            ),
          ],
          error: null,
          evidence: emptyEvidence,
          next_action: 'replan',
          warnings: [],
        },
      );
    }
    if (decoded.approval_id !== args.approval_id) {
      return response('Blueprint apply blocked: approval_id does not match the plan.', {
        status: 'blocked',
        plan_id: decoded.plan_id,
        blueprint_id: plan.blueprint_id,
        target,
        progress: baseProgress,
        attempts: [],
        blockers: [
          blocker(
            'APPROVAL_MISMATCH',
            'The supplied approval ID does not bind to this plan.',
            null,
            'Review and approve the exact latest plan output before applying.',
          ),
        ],
        error: null,
        evidence: emptyEvidence,
        next_action: 'replan',
        warnings: [],
      });
    }

    const boundaryBlockers = blueprintBoundaryBlockers(
      container.config,
      args.guild_id,
      args.expected_bot_id,
    );
    if (boundaryBlockers.length > 0) {
      return response(
        'Blueprint apply blocked by the caller profile boundary. No Discord access occurred.',
        {
          status: 'blocked',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: baseProgress,
          attempts: [],
          blockers: boundaryBlockers,
          error: null,
          evidence: emptyEvidence,
          next_action: 'fix_configuration',
          warnings: [],
        },
      );
    }

    try {
      await verifyExpectedBotIdentity(container.rest, args.expected_bot_id);
    } catch {
      return response(
        'Blueprint apply blocked by the exact bot identity lock. No guild was changed.',
        {
          status: 'blocked',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: baseProgress,
          attempts: [],
          blockers: [
            blocker(
              'EXPECTED_BOT_MISMATCH',
              'The active Discord token did not verify as the explicitly selected bot.',
              `bot:${args.expected_bot_id}`,
              'Select the correct caller-owned bot profile and restart before retrying.',
            ),
          ],
          error: null,
          evidence: emptyEvidence,
          next_action: 'fix_configuration',
          warnings: [],
        },
      );
    }

    const stateDirectory = resolveBlueprintStateDirectory(container.config);
    const targetLockStore = new BlueprintCheckpointStore({
      stateDirectory,
      planId: targetLockId(args.guild_id),
      signingSecret,
    });
    let targetLock: Awaited<ReturnType<BlueprintCheckpointStore['tryAcquireLock']>>;
    try {
      targetLock = await targetLockStore.tryAcquireLock();
    } catch (error) {
      const safeError = safeApplyError(error, null);
      return response('Blueprint apply could not acquire the local guild lock.', {
        status: 'blocked',
        plan_id: decoded.plan_id,
        blueprint_id: plan.blueprint_id,
        target,
        progress: baseProgress,
        attempts: [],
        blockers: [],
        error: safeError,
        evidence: { ...emptyEvidence, identity_verified: true },
        next_action: safeError.retriable ? 'resume' : 'fix_configuration',
        warnings: [],
      });
    }
    if (!targetLock.acquired) {
      return response(
        'Another blueprint apply is already active for this guild. No mutation was attempted.',
        {
          status: 'busy',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: baseProgress,
          attempts: [],
          blockers: [],
          error: null,
          evidence: { ...emptyEvidence, identity_verified: true },
          next_action: 'resume',
          warnings: ['Retry the same plan after the active guild apply finishes.'],
        },
      );
    }

    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: decoded.plan_id,
      signingSecret,
    });
    let planLock: Awaited<ReturnType<BlueprintCheckpointStore['tryAcquireLock']>>;
    try {
      planLock = await store.tryAcquireLock();
    } catch (error) {
      await targetLock.release().catch(() => undefined);
      const safeError = safeApplyError(error, null);
      return response('Blueprint apply could not acquire its local checkpoint lock.', {
        status: 'blocked',
        plan_id: decoded.plan_id,
        blueprint_id: plan.blueprint_id,
        target,
        progress: baseProgress,
        attempts: [],
        blockers: [],
        error: safeError,
        evidence: { ...emptyEvidence, identity_verified: true },
        next_action: safeError.retriable ? 'resume' : 'fix_configuration',
        warnings: [],
      });
    }
    if (!planLock.acquired) {
      await targetLock.release().catch(() => undefined);
      return response('This blueprint plan is already being applied. No mutation was attempted.', {
        status: 'busy',
        plan_id: decoded.plan_id,
        blueprint_id: plan.blueprint_id,
        target,
        progress: baseProgress,
        attempts: [],
        blockers: [],
        error: null,
        evidence: { ...emptyEvidence, identity_verified: true },
        next_action: 'resume',
        warnings: ['Retry the same plan after the active apply finishes.'],
      });
    }

    const lockAbort = new AbortController();
    let heartbeatPending = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void Promise.all([targetLock.heartbeat(), planLock.heartbeat()])
        .then((owned) => {
          if (owned.some((value) => !value)) lockAbort.abort();
        })
        .catch(() => lockAbort.abort())
        .finally(() => {
          heartbeatPending = false;
        });
    }, 30_000);
    heartbeatTimer.unref();
    const applySignal = AbortSignal.any([ctx.signal, lockAbort.signal]);

    let latestCheckpoint: BlueprintCheckpoint | null = null;
    let snapshotBefore: string | null = null;
    let bindings = cloneBindings(plan.initial_bindings);
    let completedOperationIds: string[] = [];
    let checkpointPersisted = false;
    let plannedThisCall = 0;
    const attempts: ApplyAttempt[] = [];
    try {
      latestCheckpoint = await store.load();
      if (latestCheckpoint !== null) {
        checkpointPersisted = true;
        if (
          latestCheckpoint.blueprint_id !== plan.blueprint_id ||
          latestCheckpoint.target.guild_id !== plan.target.guild_id ||
          latestCheckpoint.target.bot_id !== plan.target.bot_id
        ) {
          throw new BlueprintExecutionError(
            'CHECKPOINT_IDENTITY_MISMATCH',
            'Checkpoint target or blueprint identity differs from the authenticated plan.',
          );
        }
        bindings = cloneBindings(latestCheckpoint.bindings);
        completedOperationIds = [...latestCheckpoint.completed_operation_ids];
      }

      const snapshot = await readBlueprintTargetSnapshot(
        container.rest,
        args.guild_id,
        args.expected_bot_id,
        plan.blueprint,
        bindings,
      );
      const reconciled = reconcileGuildBlueprint(
        plan.blueprint_id,
        plan.blueprint,
        snapshot,
        bindings,
      );
      snapshotBefore = reconciled.snapshot_id;
      bindings = cloneBindings(reconciled.bindings);
      plannedThisCall = reconciled.operations.length;

      if (
        latestCheckpoint?.status === 'complete' &&
        (reconciled.operations.length > 0 || reconciled.blockers.length > 0)
      ) {
        return response(
          'Blueprint apply blocked: this approval was already consumed and the target has since drifted. No mutation was attempted.',
          {
            status: 'blocked',
            plan_id: decoded.plan_id,
            blueprint_id: plan.blueprint_id,
            target,
            progress: {
              ...baseProgress,
              planned_this_call: plannedThisCall,
              completed_total: completedOperationIds.length,
              remaining: plannedThisCall,
              checkpoint_version: latestCheckpoint.version,
            },
            attempts,
            blockers: [
              blocker(
                'PLAN_ALREADY_CONSUMED',
                'A completed blueprint approval cannot authorize later Discord drift repairs.',
                `guild:${args.guild_id}`,
                'Run guild_blueprint_plan again and review a fresh target-bound preview.',
              ),
              ...reconciled.blockers,
            ],
            error: null,
            evidence: {
              ...emptyEvidence,
              identity_verified: true,
              guild_verified: true,
              readback: 'drift',
              snapshot_id_before: reconciled.snapshot_id,
              snapshot_id_after: reconciled.snapshot_id,
              checkpoint_persisted: true,
              bindings,
              completed_operation_ids: completedOperationIds,
            },
            next_action: 'replan',
            warnings: reconciled.warnings,
          },
        );
      }

      if (latestCheckpoint === null && reconciled.snapshot_id !== plan.initial_snapshot_id) {
        return response('Blueprint target changed after preview. No mutation was attempted.', {
          status: 'stale',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: {
            ...baseProgress,
            planned_this_call: plannedThisCall,
            remaining: plannedThisCall,
          },
          attempts,
          blockers: [
            blocker(
              'PLAN_SNAPSHOT_STALE',
              'Live Discord state no longer matches the target-bound preview.',
              `guild:${args.guild_id}`,
              'Run guild_blueprint_plan again and review the new operation list.',
            ),
          ],
          error: null,
          evidence: {
            ...emptyEvidence,
            identity_verified: true,
            guild_verified: true,
            snapshot_id_before: reconciled.snapshot_id,
            bindings,
          },
          next_action: 'replan',
          warnings: reconciled.warnings,
        });
      }

      if (reconciled.blockers.length > 0) {
        return response(
          'Blueprint apply blocked by live drift or permissions. No mutation was attempted.',
          {
            status: 'blocked',
            plan_id: decoded.plan_id,
            blueprint_id: plan.blueprint_id,
            target,
            progress: {
              ...baseProgress,
              planned_this_call: plannedThisCall,
              completed_total: completedOperationIds.length,
              remaining: plannedThisCall,
              checkpoint_version: latestCheckpoint?.version ?? null,
            },
            attempts,
            blockers: reconciled.blockers,
            error: null,
            evidence: {
              ...emptyEvidence,
              identity_verified: true,
              guild_verified: true,
              snapshot_id_before: reconciled.snapshot_id,
              checkpoint_persisted: checkpointPersisted,
              bindings,
              completed_operation_ids: completedOperationIds,
            },
            next_action: latestCheckpoint === null ? 'replan' : 'resume',
            warnings: reconciled.warnings,
          },
        );
      }

      if (reconciled.operations.length === 0) {
        if (latestCheckpoint !== null && latestCheckpoint.status !== 'complete') {
          const completed = checkpoint(
            decoded.plan_id,
            plan,
            latestCheckpoint.version + 1,
            'complete',
            bindings,
            completedOperationIds,
            null,
          );
          await store.save(completed);
          latestCheckpoint = completed;
          checkpointPersisted = true;
        }
        return response('The locked Discord target already matches this blueprint.', {
          status: 'already_current',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: {
            ...baseProgress,
            planned_this_call: 0,
            completed_total: completedOperationIds.length,
            remaining: 0,
            checkpoint_version: latestCheckpoint?.version ?? null,
          },
          attempts,
          blockers: [],
          error: null,
          evidence: {
            identity_verified: true,
            guild_verified: true,
            readback: 'match',
            snapshot_id_before: reconciled.snapshot_id,
            snapshot_id_after: reconciled.snapshot_id,
            checkpoint_persisted: checkpointPersisted,
            bindings,
            completed_operation_ids: completedOperationIds,
          },
          next_action: 'done',
          warnings: reconciled.warnings,
        });
      }

      const applying = checkpoint(
        decoded.plan_id,
        plan,
        (latestCheckpoint?.version ?? -1) + 1,
        'applying',
        bindings,
        completedOperationIds,
        null,
      );
      await store.save(applying);
      latestCheckpoint = applying;
      checkpointPersisted = true;

      const selectedOperations = reconciled.operations.slice(0, args.operation_budget);
      for (const operation of selectedOperations) {
        let executed: Awaited<ReturnType<typeof executeBlueprintOperation>>;
        try {
          executed = await executeBlueprintOperation({
            rest: container.rest,
            plan,
            operation,
            bindings,
            snapshot,
            signal: applySignal,
          });
        } catch (error) {
          const safeError = safeApplyError(error, operation.operation_id);
          attempts.push({
            operation_id: operation.operation_id,
            status: 'failed',
            resource_id: null,
            error_code: safeError.code,
          });
          const partial = checkpoint(
            decoded.plan_id,
            plan,
            latestCheckpoint.version + 1,
            'partial',
            bindings,
            completedOperationIds,
            {
              operation_id: operation.operation_id,
              code: safeError.code,
              retriable: safeError.retriable,
            },
          );
          try {
            await store.save(partial);
            latestCheckpoint = partial;
          } catch {
            // A resume still adopts exact Discord resources from readback even
            // when recording the failure itself is unavailable.
          }
          return response(
            'Blueprint apply stopped safely after a failed operation; resume is bounded.',
            {
              status: 'partial',
              plan_id: decoded.plan_id,
              blueprint_id: plan.blueprint_id,
              target,
              progress: {
                ...baseProgress,
                planned_this_call: plannedThisCall,
                attempted_this_call: attempts.length,
                completed_total: completedOperationIds.length,
                remaining: Math.max(
                  0,
                  plannedThisCall -
                    attempts.filter((attempt) => attempt.status === 'completed').length,
                ),
                checkpoint_version: latestCheckpoint.version,
              },
              attempts,
              blockers: [],
              error: safeError,
              evidence: {
                ...emptyEvidence,
                identity_verified: true,
                guild_verified: true,
                snapshot_id_before: snapshotBefore,
                checkpoint_persisted: checkpointPersisted,
                bindings,
                completed_operation_ids: completedOperationIds,
              },
              next_action: safeError.retriable ? 'resume' : 'replan',
              warnings: reconciled.warnings,
            },
          );
        }

        checkpointPersisted = false;
        if (lockAbort.signal.aborted) {
          attempts.push({
            operation_id: operation.operation_id,
            status: 'completed',
            resource_id: executed.resource_id,
            error_code: null,
          });
          completedOperationIds = [...new Set([...completedOperationIds, operation.operation_id])];
          throw new BlueprintExecutionError(
            'APPLY_LOCK_LOST',
            'Blueprint apply lost its local guild or plan lease after a Discord mutation.',
          );
        }

        attempts.push({
          operation_id: operation.operation_id,
          status: 'completed',
          resource_id: executed.resource_id,
          error_code: null,
        });
        completedOperationIds = [...new Set([...completedOperationIds, operation.operation_id])];
        const advanced = checkpoint(
          decoded.plan_id,
          plan,
          latestCheckpoint.version + 1,
          'applying',
          bindings,
          completedOperationIds,
          null,
        );
        try {
          await store.save(advanced);
          latestCheckpoint = advanced;
          checkpointPersisted = true;
        } catch (error) {
          const safeError = safeApplyError(error, operation.operation_id);
          return response(
            'Discord changed, but the local checkpoint could not advance; stop and resume.',
            {
              status: 'partial',
              plan_id: decoded.plan_id,
              blueprint_id: plan.blueprint_id,
              target,
              progress: {
                ...baseProgress,
                planned_this_call: plannedThisCall,
                attempted_this_call: attempts.length,
                completed_total: completedOperationIds.length,
                remaining: Math.max(
                  0,
                  plannedThisCall -
                    attempts.filter((attempt) => attempt.status === 'completed').length,
                ),
                checkpoint_version: latestCheckpoint.version,
              },
              attempts,
              blockers: [],
              error: safeError,
              evidence: {
                ...emptyEvidence,
                identity_verified: true,
                guild_verified: true,
                snapshot_id_before: snapshotBefore,
                checkpoint_persisted: checkpointPersisted,
                bindings,
                completed_operation_ids: completedOperationIds,
              },
              next_action: 'resume',
              warnings: [
                ...reconciled.warnings,
                'The next call will re-read Discord and adopt exact matching resources before continuing.',
              ],
            },
          );
        }
      }

      if (lockAbort.signal.aborted) {
        throw new BlueprintExecutionError(
          'APPLY_LOCK_LOST',
          'Blueprint apply lost its local guild or plan lease before final readback.',
        );
      }
      const readbackSnapshot = await readBlueprintTargetSnapshot(
        container.rest,
        args.guild_id,
        args.expected_bot_id,
        plan.blueprint,
        bindings,
      );
      const readback = reconcileGuildBlueprint(
        plan.blueprint_id,
        plan.blueprint,
        readbackSnapshot,
        bindings,
      );
      bindings = cloneBindings(readback.bindings);
      const complete = readback.blockers.length === 0 && readback.operations.length === 0;
      const finalCheckpoint = checkpoint(
        decoded.plan_id,
        plan,
        latestCheckpoint.version + 1,
        complete ? 'complete' : 'partial',
        bindings,
        completedOperationIds,
        null,
      );
      await store.save(finalCheckpoint);
      latestCheckpoint = finalCheckpoint;
      checkpointPersisted = true;

      if (complete) {
        return response(
          'Blueprint apply completed and Discord readback matches the approved blueprint.',
          {
            status: 'complete',
            plan_id: decoded.plan_id,
            blueprint_id: plan.blueprint_id,
            target,
            progress: {
              ...baseProgress,
              planned_this_call: plannedThisCall,
              attempted_this_call: attempts.length,
              completed_total: completedOperationIds.length,
              remaining: 0,
              checkpoint_version: latestCheckpoint.version,
            },
            attempts,
            blockers: [],
            error: null,
            evidence: {
              identity_verified: true,
              guild_verified: true,
              readback: 'match',
              snapshot_id_before: snapshotBefore,
              snapshot_id_after: readback.snapshot_id,
              checkpoint_persisted: checkpointPersisted,
              bindings,
              completed_operation_ids: completedOperationIds,
            },
            next_action: 'done',
            warnings: [...reconciled.warnings, ...readback.warnings],
          },
        );
      }

      return response(
        'Blueprint apply made bounded progress; Discord readback requires another reviewed call.',
        {
          status: 'partial',
          plan_id: decoded.plan_id,
          blueprint_id: plan.blueprint_id,
          target,
          progress: {
            ...baseProgress,
            planned_this_call: plannedThisCall,
            attempted_this_call: attempts.length,
            completed_total: completedOperationIds.length,
            remaining: readback.operations.length,
            checkpoint_version: latestCheckpoint.version,
          },
          attempts,
          blockers: readback.blockers,
          error: null,
          evidence: {
            identity_verified: true,
            guild_verified: true,
            readback: 'drift',
            snapshot_id_before: snapshotBefore,
            snapshot_id_after: readback.snapshot_id,
            checkpoint_persisted: checkpointPersisted,
            bindings,
            completed_operation_ids: completedOperationIds,
          },
          next_action: readback.blockers.length > 0 ? 'replan' : 'resume',
          warnings: [...reconciled.warnings, ...readback.warnings],
        },
      );
    } catch (error) {
      const safeError = safeApplyError(error, null);
      return response('Blueprint apply stopped before another mutation could be attempted.', {
        status: latestCheckpoint === null ? 'blocked' : 'partial',
        plan_id: decoded.plan_id,
        blueprint_id: plan.blueprint_id,
        target,
        progress: {
          ...baseProgress,
          planned_this_call: plannedThisCall,
          attempted_this_call: attempts.length,
          completed_total: completedOperationIds.length,
          remaining: Math.max(
            0,
            plannedThisCall - attempts.filter((attempt) => attempt.status === 'completed').length,
          ),
          checkpoint_version: latestCheckpoint?.version ?? null,
        },
        attempts,
        blockers: [],
        error: safeError,
        evidence: {
          ...emptyEvidence,
          identity_verified: true,
          guild_verified: snapshotBefore !== null,
          snapshot_id_before: snapshotBefore,
          checkpoint_persisted: checkpointPersisted,
          bindings,
          completed_operation_ids: completedOperationIds,
        },
        next_action: safeError.retriable ? 'resume' : 'replan',
        warnings: [],
      });
    } finally {
      clearInterval(heartbeatTimer);
      await planLock.release().catch(() => undefined);
      await targetLock.release().catch(() => undefined);
    }
  },
});
