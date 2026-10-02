import { z } from 'zod';
import { ValidationError } from '../errors/client.js';
import type { ToolMiddleware } from './compose.js';

interface SchemaCarrier {
  readonly inputSchema: Record<string, z.ZodTypeAny>;
}

// Tool shapes are process-scoped and immutable; parsed caller input is never cached.
const schemas = new WeakMap<SchemaCarrier['inputSchema'], z.ZodObject>();

export function validateMiddleware(): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      const piece = ctx.meta.get('toolPiece') as SchemaCarrier | undefined;
      if (piece === undefined) {
        return next();
      }
      let schema = schemas.get(piece.inputSchema);
      if (schema === undefined) {
        schema = z.object(piece.inputSchema);
        schemas.set(piece.inputSchema, schema);
      }
      const parsed = schema.safeParse(ctx.args);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        );
      }
      (ctx as { args: unknown }).args = parsed.data;
      return next();
    },
  };
}
