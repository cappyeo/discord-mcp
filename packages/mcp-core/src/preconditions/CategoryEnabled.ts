import { ScopeRejectedError } from '../errors/client.js';
import type { MiddlewareContext } from '../middleware/compose.js';
import { Precondition } from '../pieces/Precondition.js';

/**
 * Per-tool form of the `MCP_CATEGORIES` gate.
 *
 * The gate is enforced for real by `categoryMiddleware`, which runs on every
 * call regardless of what a tool declares — a per-tool precondition puts the
 * control in the hands of whoever writes the next tool, and for the first 12
 * releases zero tools declared it, so the variable restricted nothing. This
 * class is kept because it is part of the public export surface and behaves
 * correctly if a tool does declare `preconditions: ['category_enabled']`;
 * it is not the enforcement point.
 */
export class CategoryEnabled extends Precondition {
  public override readonly identifier = 'category_enabled';
  private readonly env: Record<string, string | undefined>;

  public constructor(
    context: Precondition.Options & { name: string; path: string; root: string; store: never },
    options: Precondition.Options,
    env: Record<string, string | undefined> = process.env,
  ) {
    super(context as never, options);
    this.env = env;
  }

  public override async run(ctx: MiddlewareContext<unknown>): Promise<void> {
    const raw = this.env.MCP_CATEGORIES;
    if (raw === undefined || raw.trim() === '') {
      return;
    }
    const granted = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (granted.includes(ctx.tool.category)) {
      return;
    }
    throw new ScopeRejectedError(ctx.tool.name, ctx.tool.category, granted);
  }
}
