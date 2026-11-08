import { createHash, randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ValidationError } from '../errors/client.js';
import { fingerprintPayload } from '../tools/_lib/payload-fingerprint.js';
import { WorkflowBusyError, type WorkflowStore } from './store.js';
import {
  WORKFLOW_ID_RE,
  WORKFLOW_MAX_STEPS,
  type WorkflowInvokeContext,
  type WorkflowRecord,
  type WorkflowStatus,
  type WorkflowStepCheckpoint,
  type WorkflowStepDefinition,
  type WorkflowTarget,
  type WorkflowToolPolicy,
} from './types.js';

export interface WorkflowEngineOptions {
  readonly store: WorkflowStore;
  readonly resolvePolicy: (toolName: string) => WorkflowToolPolicy | undefined;
  readonly validateTarget?: (target: WorkflowTarget) => Promise<void> | void;
}

export interface WorkflowStartInput {
  readonly idempotency_key?: string;
  readonly target: WorkflowTarget;
  readonly steps: readonly {
    readonly id?: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }[];
}

export interface WorkflowSummary {
  readonly id: string;
  readonly status: WorkflowStatus;
  readonly target: WorkflowTarget;
  readonly current_step: number;
  readonly total_steps: number;
  readonly completed_steps: number;
  readonly cancel_requested: boolean;
  readonly failure?: { code: string; message: string };
  readonly updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function jobId(): string {
  return `wf_${randomBytes(16).toString('hex')}`;
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Invocation cancelled.';
  return 'Workflow step failed; inspect the step outcome before retrying.';
}

function summary(record: WorkflowRecord): WorkflowSummary {
  return {
    id: record.id,
    status: record.status,
    target: record.target,
    current_step: record.current_step,
    total_steps: record.steps.length,
    completed_steps: record.steps.filter((step) => step.state === 'success').length,
    cancel_requested: record.cancel_requested,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
    updated_at: record.updated_at,
  };
}

function forbiddenNestedTool(tool: string): boolean {
  return tool === 'mcp_pipeline' || tool.startsWith('workflow_');
}

export class WorkflowEngine {
  private readonly controllers = new Map<string, AbortController>();

  private schedule(id: string, context: WorkflowInvokeContext): void {
    void this.execute(id, context).catch(async (error: unknown) => {
      if (error instanceof WorkflowBusyError) return;
      try {
        await this.options.store.withLock(id, async () => {
          const record = await this.options.store.get(id);
          if (record === undefined || !['queued', 'running'].includes(record.status)) return;
          const unsafe = record.steps.some(
            (step) =>
              step.state === 'in_flight' &&
              (!step.definition.idempotent || !step.definition.retry_safe),
          );
          await this.options.store.put({
            ...record,
            status: unsafe ? 'needs_review' : 'failed',
            updated_at: now(),
            failure: {
              code: 'WORKFLOW_ENGINE_ERROR',
              message: 'Workflow executor stopped before a step outcome was recorded.',
            },
          });
        });
      } catch {
        /* preserve the original durable checkpoint when it cannot be read */
      }
    });
  }

  public constructor(private readonly options: WorkflowEngineOptions) {}

  public async start(
    input: WorkflowStartInput,
    context: WorkflowInvokeContext,
  ): Promise<WorkflowSummary> {
    await this.options.store.init();
    if (
      context.trustedTarget === undefined ||
      digest(context.trustedTarget) !== digest(input.target)
    ) {
      throw new Error('Workflow target is not bound to this trusted server instance.');
    }
    await this.options.validateTarget?.(context.trustedTarget);
    if (
      !input.target.profile_id ||
      input.target.profile_id.includes('/') ||
      input.target.profile_id.includes('\\')
    ) {
      throw new Error('A trusted bot profile binding is required.');
    }
    if (input.steps.length === 0 || input.steps.length > WORKFLOW_MAX_STEPS) {
      throw new Error(`A workflow must contain 1-${WORKFLOW_MAX_STEPS} steps.`);
    }
    const ids = new Set<string>();
    const steps: WorkflowStepCheckpoint[] = input.steps.map((step, index) => {
      const id = step.id ?? `step_${index}`;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) throw new Error(`Invalid workflow step id: ${id}`);
      if (ids.has(id)) throw new Error(`Duplicate workflow step id: ${id}`);
      ids.add(id);
      if (forbiddenNestedTool(step.tool))
        throw new Error('Nested workflows and pipelines are not permitted.');
      for (const field of ['bot_id', 'expected_bot_id', 'guild_id'] as const) {
        const value = step.args[field];
        if (value === undefined) continue;
        const targetField = field === 'expected_bot_id' ? 'bot_id' : field;
        if (input.target[targetField] !== undefined && value !== input.target[targetField])
          throw new Error(`Workflow step target drift: ${targetField}.`);
        if (input.target[targetField] === undefined && context.authorizeStep === undefined)
          throw new Error(`Workflow step target cannot be verified: ${targetField}.`);
      }
      if (
        step.args.channel_id !== undefined &&
        input.target.channel_id !== undefined &&
        step.args.channel_id !== input.target.channel_id
      )
        throw new Error('Workflow step target drift: channel_id.');
      if (
        step.args.channel_id !== undefined &&
        input.target.channel_id === undefined &&
        (input.target.guild_id === undefined || context.authorizeStep === undefined)
      )
        throw new Error(
          'Workflow channel target requires a trusted guild binding and step authorizer.',
        );
      const policy = this.options.resolvePolicy(step.tool);
      if (policy === undefined) throw new Error(`Unknown workflow tool: ${step.tool}`);
      const definition: WorkflowStepDefinition = {
        id,
        tool: step.tool,
        args: structuredClone(step.args),
        idempotent: policy.idempotent,
        retry_safe: policy.retry_safe,
      };
      return { definition, state: 'pending' };
    });
    const key = input.idempotency_key;
    const startFingerprint =
      key === undefined
        ? undefined
        : fingerprintPayload({ target: input.target, steps: input.steps });
    const created = now();
    const record: WorkflowRecord = {
      schema_version: 'workflow.v1',
      id: key === undefined ? jobId() : this.options.store.idForStartKey(key),
      created_at: created,
      updated_at: created,
      status: 'queued',
      target: structuredClone(input.target),
      target_fingerprint: digest(input.target),
      ...(startFingerprint === undefined ? {} : { start_fingerprint: startFingerprint }),
      steps,
      current_step: 0,
      cancel_requested: false,
    };
    if (key === undefined) {
      await this.options.store.clearCancel(record.id);
      await this.options.store.put(record);
    } else if (!(await this.options.store.create(record))) {
      const existing = await this.options.store.get(record.id);
      if (startFingerprint === undefined || existing?.start_fingerprint !== startFingerprint) {
        throw new ValidationError([
          {
            path: 'idempotency_key',
            code: 'WORKFLOW_KEY_REUSED',
            message:
              'Use the original target and steps with this key, or a new key for a new workflow.',
          },
        ]);
      }
      return summary(existing);
    }
    // The durable record exists before work is scheduled; callers receive the ID promptly.
    this.schedule(record.id, context);
    return summary(record);
  }

  public async status(
    id: string,
    target: WorkflowTarget,
    context?: WorkflowInvokeContext,
  ): Promise<WorkflowSummary> {
    const record = await this.requireRecord(id, target);
    await this.assertContextTarget(target, context);
    if (record.status === 'completed' || record.status === 'cancelled')
      await this.options.store.clearCancel(id);
    if (
      record.status !== 'completed' &&
      record.status !== 'cancelled' &&
      (await this.options.store.isCancelRequested(id))
    ) {
      return summary({
        ...record,
        status: 'cancel_requested',
        cancel_requested: true,
        updated_at: now(),
      });
    }
    return summary(record);
  }

  public async cancel(
    id: string,
    target: WorkflowTarget,
    context?: WorkflowInvokeContext,
  ): Promise<WorkflowSummary> {
    const record = await this.requireRecord(id, target);
    await this.assertContextTarget(target, context);
    if (record.status === 'completed' || record.status === 'cancelled') {
      await this.options.store.clearCancel(id);
      return summary(record);
    }
    await this.options.store.requestCancel(id);
    this.controllers.get(id)?.abort();
    return summary({
      ...record,
      cancel_requested: true,
      status: 'cancel_requested',
      updated_at: now(),
    });
  }

  public async resume(
    id: string,
    target: WorkflowTarget,
    context: WorkflowInvokeContext,
  ): Promise<WorkflowSummary> {
    await this.assertContextTarget(target, context);
    await this.options.validateTarget?.(context.trustedTarget ?? target);
    let record!: WorkflowRecord;
    await this.options.store.withLock(id, async () => {
      record = await this.requireRecord(id, target);
      if (record.status === 'completed' || record.status === 'cancelled') return;
      const inFlight = record.steps[record.current_step];
      if (inFlight?.state === 'in_flight') {
        if (!inFlight.definition.idempotent || !inFlight.definition.retry_safe) {
          record = {
            ...record,
            status: 'needs_review',
            updated_at: now(),
            failure: {
              code: 'WORKFLOW_OUTCOME_UNKNOWN',
              message:
                'An in-flight step may have changed Discord; explicit outcome review is required.',
            },
          };
          await this.options.store.put(record);
          return;
        }
        const reset: WorkflowStepCheckpoint = { definition: inFlight.definition, state: 'pending' };
        const { failure: _failure, ...withoutFailure } = record;
        record = {
          ...withoutFailure,
          steps: record.steps.map((step, index) => (index === record.current_step ? reset : step)),
          status: 'queued',
          updated_at: now(),
        };
        await this.options.store.put(record);
      } else if (
        record.status === 'failed' &&
        inFlight?.state === 'error' &&
        inFlight.definition.idempotent &&
        inFlight.definition.retry_safe
      ) {
        const reset: WorkflowStepCheckpoint = { definition: inFlight.definition, state: 'pending' };
        const { failure: _failure, ...withoutFailure } = record;
        record = {
          ...withoutFailure,
          steps: record.steps.map((step, index) => (index === record.current_step ? reset : step)),
          status: 'queued',
          updated_at: now(),
        };
        await this.options.store.put(record);
      } else if (record.status === 'failed') {
        record = {
          ...record,
          status: 'needs_review',
          updated_at: now(),
          failure: {
            code: 'WORKFLOW_RETRY_REQUIRES_REVIEW',
            message:
              'The failed step is not policy-approved for automatic replay; review its Discord outcome first.',
          },
        };
        await this.options.store.put(record);
      }
    });
    if (
      record.status === 'completed' ||
      record.status === 'cancelled' ||
      record.status === 'needs_review'
    )
      return summary(record);
    this.schedule(id, context);
    return summary(record);
  }

  private async requireRecord(id: string, target: WorkflowTarget): Promise<WorkflowRecord> {
    if (!WORKFLOW_ID_RE.test(id)) throw new Error('Invalid workflow ID.');
    const record = await this.options.store.get(id);
    if (record === undefined) throw new Error('Workflow not found.');
    if (record.target_fingerprint !== digest(target))
      throw new Error('Workflow target binding does not match.');
    return record;
  }

  private async assertContextTarget(
    target: WorkflowTarget,
    context?: WorkflowInvokeContext,
  ): Promise<void> {
    if (
      context !== undefined &&
      (context.trustedTarget === undefined || digest(context.trustedTarget) !== digest(target))
    ) {
      throw new Error('Workflow target is not bound to this trusted server instance.');
    }
    await this.options.validateTarget?.(context?.trustedTarget ?? target);
  }

  private async execute(id: string, context: WorkflowInvokeContext): Promise<void> {
    await this.options.store.withLock(id, async () => {
      let record = await this.options.store.get(id);
      if (
        record === undefined ||
        record.status === 'completed' ||
        record.status === 'cancelled' ||
        record.status === 'needs_review'
      )
        return;
      const controller = new AbortController();
      this.controllers.set(id, controller);
      const signal = controller.signal;
      try {
        record = { ...record, status: 'running', updated_at: now() };
        await this.options.store.put(record);
        for (let index = record.current_step; index < record.steps.length; index += 1) {
          record = await this.options.store.get(id);
          if (record === undefined) return;
          if (
            record.cancel_requested ||
            signal.aborted ||
            (await this.options.store.isCancelRequested(id))
          ) {
            await this.options.store.put({ ...record, status: 'cancelled', updated_at: now() });
            return;
          }
          const step = record.steps[index]!;
          if (step.state === 'success' || step.state === 'skipped') continue;
          const freshPolicy = this.options.resolvePolicy(step.definition.tool);
          if (
            freshPolicy === undefined ||
            freshPolicy.idempotent !== step.definition.idempotent ||
            freshPolicy.retry_safe !== step.definition.retry_safe
          ) {
            await this.options.store.put({
              ...record,
              status: 'needs_review',
              current_step: index,
              updated_at: now(),
              failure: {
                code: 'WORKFLOW_POLICY_CHANGED',
                message: 'The tool retry policy changed; review before resuming.',
              },
            });
            return;
          }
          const args = structuredClone(step.definition.args) as Record<string, unknown>;
          try {
            for (const field of ['bot_id', 'expected_bot_id', 'guild_id'] as const) {
              const value = args[field];
              if (value === undefined) continue;
              const targetField = field === 'expected_bot_id' ? 'bot_id' : field;
              if (record.target[targetField] !== undefined && value !== record.target[targetField])
                throw new Error('target drift');
              if (record.target[targetField] === undefined && context.authorizeStep === undefined)
                throw new Error('unbound target');
            }
            if (
              args.channel_id !== undefined &&
              record.target.channel_id !== undefined &&
              args.channel_id !== record.target.channel_id
            )
              throw new Error('target drift');
            if (
              args.channel_id !== undefined &&
              record.target.channel_id === undefined &&
              (record.target.guild_id === undefined || context.authorizeStep === undefined)
            )
              throw new Error('unbound channel');
            await context.authorizeStep?.(step.definition.tool, args, record.target);
          } catch {
            const rejected = {
              code: 'WORKFLOW_TARGET_REJECTED',
              message: 'Workflow step target could not be authorized.',
            };
            await this.options.store.put({
              ...record,
              status: 'failed',
              current_step: index,
              updated_at: now(),
              failure: rejected,
              steps: record.steps.map((item, i) =>
                i === index
                  ? {
                      ...item,
                      state: 'error',
                      finished_at: now(),
                      error: { ...rejected, retriable: false },
                    }
                  : item,
              ),
            });
            return;
          }
          const inFlight: WorkflowStepCheckpoint = {
            ...step,
            state: 'in_flight',
            started_at: now(),
          };
          await this.options.store.put({
            ...record,
            status: 'running',
            current_step: index,
            steps: record.steps.map((item, i) => (i === index ? inFlight : item)),
            updated_at: now(),
          });
          let result: CallToolResult;
          try {
            result = await context.invoke(step.definition.tool, args, signal);
          } catch (error) {
            const unknown = !step.definition.idempotent || !step.definition.retry_safe;
            const failed: WorkflowRecord = {
              ...record,
              status: unknown ? 'needs_review' : 'failed',
              current_step: index,
              updated_at: now(),
              failure: {
                code: unknown ? 'WORKFLOW_OUTCOME_UNKNOWN' : 'WORKFLOW_STEP_THROWN',
                message: safeMessage(error),
              },
              steps: record.steps.map((item, i) =>
                i === index ? { ...inFlight, state: 'in_flight' } : item,
              ),
            };
            await this.options.store.put(failed);
            return;
          }
          if (result.isError === true) {
            const payload = (result.structuredContent ?? {}) as {
              code?: string;
              retriable?: boolean;
            };
            const code = payload.code ?? 'WORKFLOW_STEP_ERROR';
            const noEffect = new Set([
              'VALIDATION_ERROR',
              'SCOPE_REJECTED',
              'PAYLOAD_CONFIRMATION_REQUIRED',
              'CATEGORY_DISABLED',
              'GUILD_NOT_ALLOWED',
            ]);
            const uncertain =
              !noEffect.has(code) && (!step.definition.idempotent || !step.definition.retry_safe);
            const failed: WorkflowRecord = {
              ...record,
              status: uncertain ? 'needs_review' : 'failed',
              current_step: index,
              updated_at: now(),
              failure: {
                code: uncertain ? 'WORKFLOW_OUTCOME_UNKNOWN' : code,
                message: uncertain
                  ? 'The step returned an error after invocation; review Discord state before retrying.'
                  : 'Workflow step returned an error.',
              },
              steps: record.steps.map((item, i) =>
                i === index
                  ? {
                      ...inFlight,
                      state: 'error',
                      finished_at: now(),
                      error: {
                        code,
                        message: uncertain
                          ? 'Outcome may be unknown.'
                          : 'Workflow step returned an error.',
                        retriable: payload.retriable === true,
                      },
                    }
                  : item,
              ),
            };
            await this.options.store.put(failed);
            return;
          }
          const resultStatus = (result.structuredContent as { status?: unknown } | undefined)
            ?.status;
          if (
            typeof resultStatus === 'string' &&
            new Set([
              'blocked',
              'partial',
              'busy',
              'stale',
              'drifted',
              'needs_review',
              'unverified',
            ]).has(resultStatus)
          ) {
            const incomplete = {
              code: 'WORKFLOW_STEP_INCOMPLETE',
              message: 'The step returned an incomplete outcome; review it before continuing.',
            };
            await this.options.store.put({
              ...record,
              status: 'needs_review',
              current_step: index,
              updated_at: now(),
              failure: incomplete,
              steps: record.steps.map((item, i) =>
                i === index
                  ? {
                      ...inFlight,
                      state: 'error',
                      finished_at: now(),
                      result_summary: { status: resultStatus },
                      error: { ...incomplete, retriable: false },
                    }
                  : item,
              ),
            });
            return;
          }
          const completed: WorkflowStepCheckpoint = {
            ...inFlight,
            state: 'success',
            finished_at: now(),
            result_summary: {
              ok: true,
              has_structured_content: result.structuredContent !== undefined,
            },
          };
          record = {
            ...record,
            status: 'running',
            current_step: index + 1,
            steps: record.steps.map((item, i) => (i === index ? completed : item)),
            updated_at: now(),
          };
          await this.options.store.put(record);
        }
        if (await this.options.store.isCancelRequested(id))
          await this.options.store.put({ ...record, status: 'cancelled', updated_at: now() });
        else await this.options.store.put({ ...record, status: 'completed', updated_at: now() });
      } finally {
        this.controllers.delete(id);
      }
    });
  }
}
