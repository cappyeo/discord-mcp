import { z } from 'zod';
import { Tool, type ToolAnnotations, type ToolRunContext } from '../../pieces/Tool.js';

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface ToolDefinition<I extends Record<string, z.ZodTypeAny>, O> {
  name: string;
  description: string;
  /** Tool category (e.g. "messages", "channels", "intelligence"). Default "misc". */
  category?: string;
  /** Precondition identifiers to run before the handler. */
  preconditions?: readonly string[];
  /** Required MCP scopes (informational v1). */
  scopes?: readonly string[];
  inputSchema: I;
  outputSchema?: Record<string, z.ZodTypeAny>;
  annotations: ToolAnnotations;
  idempotent?: boolean;
  handler: (args: { [K in keyof I]: z.infer<I[K]> }, ctx: ToolRunContext) => Promise<O>;
}

/**
 * Static metadata attached to every class returned by `defineTool` for
 * build-time introspection (e.g. the docs-site generator). Read this via
 * `(ToolClass as { __toolMetadata?: ToolMetadataStatic }).__toolMetadata`.
 *
 * Sapphire piece loading reads instance fields (set by the constructor),
 * not statics - so this is purely additive and does not affect runtime.
 */
export interface ToolMetadataStatic {
  name: string;
  category: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny> | undefined;
  annotations: ToolAnnotations;
  idempotent: boolean;
  preconditions: readonly string[];
}

/**
 * Under vitest, assert a handler's `structuredContent` matches the tool's own
 * declared `outputSchema`.
 *
 * This lives HERE, at the point the result is produced, rather than in
 * `server.ts`'s `invokeTool`. When it lived in invokeTool it validated only the
 * handful of tools reachable through the MCP contract test - the other ~190
 * tool tests instantiate the tool class and call `.run()` directly, bypassing
 * the dispatcher entirely. A guard that covers 7 of 191 tools reports safety it
 * does not provide.
 *
 * Test-only: a production call must never fail because of a schema mismatch
 * that can be corrected in a patch. Since v0.13.0 publishes these schemas and
 * SDK >= 1.20 clients validate against them, a mismatch is now a client-side
 * throw on a successful call - which is exactly why it must be caught here.
 */
const ENFORCE_OUTPUT_SCHEMA = process.env.VITEST === 'true';

/** Distinct type so callers can rethrow it past their generic error handling. */
export class OutputSchemaViolation extends Error {
  public override readonly name = 'OutputSchemaViolation';
}

function assertMatchesOutputSchema(
  toolName: string,
  outputSchema: Record<string, z.ZodTypeAny>,
  result: unknown,
): void {
  const structured =
    (result as { structuredContent?: unknown; isError?: boolean } | undefined) ?? {};
  // Error results carry the error envelope, not the success shape.
  if (structured.isError === true || structured.structuredContent === undefined) return;
  const parsed = z.looseObject(outputSchema).safeParse(structured.structuredContent);
  if (parsed.success) return;
  throw new OutputSchemaViolation(
    `[outputSchema] ${toolName} returned structuredContent that violates its declared ` +
      `outputSchema: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
  );
}

export function defineTool<I extends Record<string, z.ZodTypeAny>, O>(
  def: ToolDefinition<I, O>,
): typeof Tool {
  if (!TOOL_NAME_RE.test(def.name)) {
    throw new Error(
      `Tool name '${def.name}' invalid: must be snake_case starting with a lowercase letter, max 64 chars (regex: ${TOOL_NAME_RE.source}).`,
    );
  }

  class GeneratedTool extends Tool {
    public override readonly description = def.description;
    public override readonly inputSchema = def.inputSchema;
    // outputSchema is optional on the base class; only set when provided to
    // avoid overriding the base undefined with an explicit undefined.
    public override readonly annotations = def.annotations;
    public override readonly idempotent = def.idempotent ?? false;
    public override readonly category = def.category ?? 'misc';
    public override readonly preconditions = def.preconditions ?? [];
    public override readonly scopes = def.scopes ?? [];

    constructor(...args: ConstructorParameters<typeof Tool>) {
      super(...args);
      if (def.outputSchema !== undefined) {
        (this as { outputSchema?: Record<string, z.ZodTypeAny> }).outputSchema = def.outputSchema;
      }
    }

    public override async run(args: unknown, ctx: ToolRunContext): Promise<unknown> {
      const result = await def.handler(args as { [K in keyof I]: z.infer<I[K]> }, ctx);
      if (ENFORCE_OUTPUT_SCHEMA && def.outputSchema !== undefined) {
        assertMatchesOutputSchema(def.name, def.outputSchema, result);
      }
      return result;
    }
  }

  // Sapphire reads `name` from constructor.options at registration time -
  // we set the static name as a hint only.
  Object.defineProperty(GeneratedTool, 'name', { value: def.name });

  // Build-time introspection hook (read by site/scripts/generate-tool-docs.ts).
  // Sapphire only consults instance fields, so attaching a static is safe.
  Object.assign(GeneratedTool, {
    __toolMetadata: {
      name: def.name,
      category: def.category ?? 'misc',
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
      idempotent: def.idempotent ?? false,
      preconditions: def.preconditions ?? [],
    } satisfies ToolMetadataStatic,
  });

  // Cast to `typeof Tool` - GeneratedTool is concrete but defineTool returns the
  // abstract base type so callers can instantiate via the concrete subclass.
  return GeneratedTool as unknown as typeof Tool;
}
