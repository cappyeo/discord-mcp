import {
  type AccessMode,
  evaluateRuntimeAccess,
  type RuntimeAccessEvidence,
  type RuntimeAccessResolver,
  type runtimeAccessRequirement,
  runtimeAccessRequirementForArgs,
} from '../access/runtime.js';
import { RuntimeAccessDeniedError, RuntimeAccessUnknownError } from '../errors/client.js';
import type { ToolMiddleware } from './compose.js';

export interface RuntimeAccessMiddlewareOptions {
  readonly mode: AccessMode;
  readonly expectedBotId?: string;
  readonly resolve?: RuntimeAccessResolver;
  readonly warn?: (message: string) => void;
}

/** Advisory/warn preserve execution; enforce rejects unknown evidence fail-closed. */
export function runtimeAccessMiddleware(options: RuntimeAccessMiddlewareOptions): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (options.mode === 'advisory' && options.resolve === undefined) return next();
      const piece = ctx.meta.get('toolPiece') as
        | { access?: Parameters<typeof runtimeAccessRequirement>[1] }
        | undefined;
      const requirement = runtimeAccessRequirementForArgs(ctx.tool.name, ctx.args, piece?.access);
      if (requirement === null) {
        return handleUnknown(
          options,
          ctx.tool.name,
          'tool access requirement is not catalogued',
          next,
        );
      }
      if (
        requirement.auth === 'bearer' ||
        requirement.auth === 'opaque' ||
        requirement.auth === 'none'
      )
        return next();
      if (options.resolve === undefined) {
        return handleUnknown(
          options,
          ctx.tool.name,
          'no runtime access evidence provider is configured',
          next,
        );
      }
      let evidence: RuntimeAccessEvidence;
      try {
        evidence = await options.resolve({
          toolName: ctx.tool.name,
          args: ctx.args,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          requirement,
          ...(options.expectedBotId === undefined ? {} : { expectedBotId: options.expectedBotId }),
        });
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        return handleUnknown(
          options,
          ctx.tool.name,
          'runtime access evidence provider failed',
          next,
        );
      }
      const decision = evaluateRuntimeAccess(
        {
          toolName: ctx.tool.name,
          args: ctx.args,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          requirement,
          ...(options.expectedBotId === undefined ? {} : { expectedBotId: options.expectedBotId }),
        },
        evidence,
      );
      if (decision.status === 'allowed') return next();
      if (decision.status === 'denied') {
        if (options.mode === 'enforce') {
          throw new RuntimeAccessDeniedError(
            ctx.tool.name,
            decision.missingPermissions,
            decision.missingIntents,
            decision.hierarchy,
          );
        }
        options.warn?.(`${ctx.tool.name}: ${decision.reason}`);
        return next();
      }
      return handleUnknown(options, ctx.tool.name, decision.reason, next);
    },
  };
}

async function handleUnknown<R>(
  options: RuntimeAccessMiddlewareOptions,
  toolName: string,
  reason: string,
  next: () => Promise<R>,
): Promise<R> {
  if (options.mode === 'enforce') throw new RuntimeAccessUnknownError(toolName, reason);
  options.warn?.(`${toolName}: ${reason}`);
  return next();
}
