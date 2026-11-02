import { z } from 'zod';
import type { DiscordAccessRequirement } from '../../access/requirements.js';
import {
  Tool,
  type ToolAnnotations,
  type ToolConfirmation,
  type ToolRunContext,
} from '../../pieces/Tool.js';

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
  /** Optional shared approval contract. */
  confirmation?: ToolConfirmation;
  /** Optional machine-readable Discord permission/data-access contract. */
  access?: DiscordAccessRequirement;
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
  confirmation?: ToolConfirmation;
  access?: DiscordAccessRequirement;
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

const DESCRIPTION_SECTION_RE = /\*\*([^*\n]+)\*\*:[ \t]*\n?([\s\S]*?)(?=\n\s*\*\*[^*\n]+\*\*:|$)/g;

/**
 * Collapse a section body (or a heading-less description) into one line per
 * authored paragraph. Paragraph breaks survive because `compactSummary()`
 * (`tool-discovery.ts`) feeds the first paragraph to `mcp_tools_search` results;
 * merging paragraphs would push a URL or a second sentence into that summary.
 */
function compactText(text: string): string {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

/**
 * Compact the authored NLT description for the MCP wire.
 *
 * Keep every section, including Returns: its prose can carry semantics that
 * an output schema does not express. Full authored text stays in metadata for
 * docs. Fenced examples retain their exact formatting on the wire as well.
 */
function compactDescription(description: string): string {
  if (/^\s*```/m.test(description)) return description.trim();
  const parts: string[] = [];
  let lastIndex = 0;
  let matched = false;

  for (const section of description.matchAll(DESCRIPTION_SECTION_RE)) {
    matched = true;
    const index = section.index ?? 0;
    if (index > lastIndex) {
      const leading = compactText(description.slice(lastIndex, index));
      if (leading !== '') parts.push(leading);
    }
    lastIndex = index + section[0].length;
    const heading = section[1]!.trim();
    const body = compactText(section[2]!);
    parts.push(body === '' ? `${heading}:` : `${heading}: ${body}`);
  }

  // 19 descriptions carry no `**Heading**:` marker at all.
  if (!matched) return compactText(description);

  const tail = compactText(description.slice(lastIndex));
  if (tail !== '') parts.push(tail);

  // `catalog --check` rejects an empty description; never produce one.
  return parts.length === 0 ? description.trim() : parts.join('\n\n');
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
    public override readonly description = compactDescription(def.description);
    public override readonly inputSchema = def.inputSchema;
    // outputSchema is optional on the base class; only set when provided to
    // avoid overriding the base undefined with an explicit undefined.
    public override readonly annotations = def.annotations;
    public override readonly idempotent = def.idempotent ?? false;
    public override readonly category = def.category ?? 'misc';
    public override readonly preconditions = def.preconditions ?? [];
    public override readonly confirmation = def.confirmation;
    public override readonly access = def.access;
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
      ...(def.confirmation === undefined ? {} : { confirmation: def.confirmation }),
      ...(def.access === undefined ? {} : { access: def.access }),
    } satisfies ToolMetadataStatic,
  });

  // Cast to `typeof Tool` - GeneratedTool is concrete but defineTool returns the
  // abstract base type so callers can instantiate via the concrete subclass.
  return GeneratedTool as unknown as typeof Tool;
}
