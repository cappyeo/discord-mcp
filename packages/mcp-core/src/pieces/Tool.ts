import { Piece } from '@sapphire/pieces';
import type { z } from 'zod';

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolRunContext {
  readonly signal: AbortSignal;
}

export abstract class Tool extends Piece<Tool.Options, 'tools'> {
  /** Markdown description following NLT template (purpose / when_to_use / when_not / example / returns). */
  public abstract readonly description: string;

  /** Bare zod shape - keys become input parameter names. Use .describe() on every field. */
  public abstract readonly inputSchema: Record<string, z.ZodTypeAny>;

  /** Optional zod shape for structuredContent validation. */
  public readonly outputSchema?: Record<string, z.ZodTypeAny>;

  /** MCP tool annotations rendered in tools/list. */
  public abstract readonly annotations: ToolAnnotations;

  /** True if the tool is GET-shaped and safe to single-flight-coalesce. */
  public readonly idempotent: boolean = false;

  /** Tool category - used by CategoryEnabled precondition + tools/list grouping. */
  public readonly category: string = 'misc';

  /** Identifiers of preconditions to run before the handler. */
  public readonly preconditions: readonly string[] = [];

  /** Optional MCP scopes the tool requires (informational v1; gating lands v2 with OAuth). */
  public readonly scopes: readonly string[] = [];

  /** Implement the tool body. */
  public abstract run(args: unknown, ctx?: ToolRunContext): Promise<unknown>;
}

export namespace Tool {
  export type Options = Piece.Options;
}
