import { redactArgs } from '../audit/redact.js';
import { DryRunPreview } from '../errors/client.js';
import type { MiddlewareContext } from '../middleware/compose.js';
import { Precondition } from '../pieces/Precondition.js';

export class ConfirmRequired extends Precondition {
  public override readonly identifier = 'confirm_required';
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
    const dryRunActive = this.env.MCP_DRY_RUN !== 'false';
    const args = ctx.args as Record<string, unknown>;
    // `__confirm` is not declared by any tool inputSchema, so validateMiddleware
    // (which runs first and replaces ctx.args with the zod-parsed object) strips
    // it. server.ts stashes the pre-validation payload under `rawArgs`; fall back
    // to ctx.args for direct run() calls that bypass the middleware chain.
    const raw = (ctx.meta.get('rawArgs') as Record<string, unknown> | undefined) ?? args;
    const confirmed = raw.__confirm === true;

    if (dryRunActive || !confirmed) {
      const previewArgs = { ...args };
      delete previewArgs.__confirm;
      throw new DryRunPreview(ctx.tool.name, redactArgs(previewArgs, ctx.tool.name));
    }
  }
}
