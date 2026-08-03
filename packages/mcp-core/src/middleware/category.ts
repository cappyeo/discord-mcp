import { ScopeRejectedError } from '../errors/client.js';
import type { ToolMiddleware } from './compose.js';

/**
 * Category allowlist - the `MCP_CATEGORIES` least-privilege control.
 *
 * Enforced here rather than as a per-tool precondition: attaching
 * `preconditions: ['category_enabled']` to 201 tool files would put the gate
 * in the hands of whoever writes the next tool, and a tool that forgets it is
 * silently exempt. One middleware in the chain covers every tool that exists
 * and every tool anyone adds.
 *
 * Unset means allow-all - this narrows a deployment's blast radius, it is not
 * a deny-by-default authorization system, and flipping the default would break
 * every existing install.
 *
 * `meta` is always reachable so introspection (`mcp_pipeline`) does not vanish
 * on a scoped deployment. Note that pipeline steps re-enter `invokeTool`, so
 * each step is gated on its own category regardless.
 */
export const ALWAYS_ALLOWED_CATEGORIES: ReadonlySet<string> = new Set(['meta']);

export function categoryMiddleware(allowed: ReadonlySet<string> | null): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (allowed === null) {
        return next();
      }
      const category = ctx.tool.category;
      if (allowed.has(category) || ALWAYS_ALLOWED_CATEGORIES.has(category)) {
        return next();
      }
      throw new ScopeRejectedError(ctx.tool.name, category, [...allowed].sort());
    },
  };
}

/**
 * Parse the `MCP_CATEGORIES` env value. Returns `null` for unset/blank, which
 * means "no restriction".
 */
export function parseCategoryAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length === 0 ? null : new Set(entries);
}
