import { redactArgs } from '../audit/redact.js';
import type { Config } from '../config.js';
import { WritePreview } from '../errors/client.js';
import type { ToolMiddleware } from './compose.js';

interface ToolPieceWithAnnotations {
  readonly annotations: { readonly readOnlyHint: boolean };
}

/**
 * Opt-in global no-mutation mode. This lives in the common middleware chain
 * rather than individual tool declarations so a newly added write cannot
 * accidentally bypass it. It runs after validation and authorization, but
 * before preconditions and audit because no Discord operation was attempted.
 *
 * `allow` deliberately preserves the legacy behavior. `preview` fails closed:
 * a missing tool annotation is treated as a mutation rather than as a read.
 */
export function writePreviewMiddleware(mode: Config['MCP_WRITE_MODE']): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (mode === 'allow') {
        return next();
      }
      const piece = ctx.meta.get('toolPiece') as ToolPieceWithAnnotations | undefined;
      if (piece?.annotations.readOnlyHint === true) {
        return next();
      }
      throw new WritePreview(ctx.tool.name, redactArgs(ctx.args, ctx.tool.name));
    },
  };
}
