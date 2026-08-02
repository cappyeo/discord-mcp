import type { CallToolResult } from '@modelcontextprotocol/server';
import { evalCondition, interpolate } from './interpolate.js';

export interface Step {
  readonly id?: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly save_as?: string;
  readonly if?: string;
  readonly continue_on_error?: boolean;
}

export interface StepResult {
  readonly id: string;
  readonly tool: string;
  readonly status: 'success' | 'error' | 'skipped';
  readonly result?: unknown;
  readonly error?: { code: string; message: string; retriable: boolean };
  readonly duration_ms: number;
}

export interface PipelineResult {
  readonly steps: readonly StepResult[];
  readonly variables: Readonly<Record<string, unknown>>;
  readonly total_duration_ms: number;
  readonly aborted: boolean;
}

export interface PipelineExecutorCtx {
  readonly signal: AbortSignal;
}

export type InvokeFn = (
  toolName: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<CallToolResult>;

interface ErrorPayload {
  code?: string;
  retriable?: boolean;
}

export async function executePipeline(
  steps: readonly Step[],
  invoke: InvokeFn,
  ctx: PipelineExecutorCtx,
): Promise<PipelineResult> {
  const variables: Record<string, unknown> = {};
  const results: StepResult[] = [];
  const totalStart = performance.now();
  let aborted = ctx.signal.aborted;

  for (let i = 0; i < steps.length && !aborted; i++) {
    const step = steps[i]!;
    const id = step.id ?? `step_${i}`;

    if (ctx.signal.aborted) {
      aborted = true;
      break;
    }

    if (step.if !== undefined) {
      if (!evalCondition(step.if, variables)) {
        results.push({ id, tool: step.tool, status: 'skipped', duration_ms: 0 });
        continue;
      }
    }

    const interpolatedArgs = interpolate(step.args, variables) as Record<string, unknown>;
    const stepStart = performance.now();
    let stepResult: StepResult;
    try {
      const callResult = await invoke(step.tool, interpolatedArgs, ctx.signal);
      const duration = performance.now() - stepStart;
      if (callResult.isError === true) {
        const payload = (callResult.structuredContent ?? {}) as ErrorPayload;
        const text = (callResult.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
        stepResult = {
          id,
          tool: step.tool,
          status: 'error',
          error: {
            code: payload.code ?? 'UNKNOWN',
            message: text,
            retriable: payload.retriable === true,
          },
          duration_ms: duration,
        };
      } else {
        const data = callResult.structuredContent;
        variables[id] = data;
        if (step.save_as !== undefined) variables[step.save_as] = data;
        stepResult = {
          id,
          tool: step.tool,
          status: 'success',
          result: data,
          duration_ms: duration,
        };
      }
    } catch (e) {
      const duration = performance.now() - stepStart;
      const message = e instanceof Error ? e.message : String(e);
      stepResult = {
        id,
        tool: step.tool,
        status: 'error',
        error: { code: 'PIPELINE_INTERNAL', message, retriable: false },
        duration_ms: duration,
      };
    }

    results.push(stepResult);

    if (stepResult.status === 'error' && step.continue_on_error !== true) {
      aborted = true;
      break;
    }
  }

  return {
    steps: results,
    variables,
    total_duration_ms: performance.now() - totalStart,
    aborted,
  };
}
