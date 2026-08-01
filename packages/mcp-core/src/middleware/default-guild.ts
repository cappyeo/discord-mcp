import type { z } from 'zod';
import type { ToolMiddleware } from './compose.js';

interface SchemaCarrier {
  readonly inputSchema: Record<string, z.ZodTypeAny>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Supplies the operator-configured guild only to tools that explicitly declare
 * a top-level `guild_id` field. Explicit caller input always wins.
 */
export function defaultGuildMiddleware(defaultGuildId: string | undefined): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (
        defaultGuildId === undefined ||
        !isRecord(ctx.args) ||
        Object.hasOwn(ctx.args, 'guild_id')
      ) {
        return next();
      }
      const tool = ctx.meta.get('toolPiece') as SchemaCarrier | undefined;
      if (tool === undefined || !Object.hasOwn(tool.inputSchema, 'guild_id')) {
        return next();
      }
      (ctx as { args: unknown }).args = { ...ctx.args, guild_id: defaultGuildId };
      return next();
    },
  };
}
