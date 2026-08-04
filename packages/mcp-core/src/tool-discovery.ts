import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const PROGRESSIVE_SEARCH_TOOL_NAME = 'mcp_tools_search';
export const PROGRESSIVE_READ_TOOL_NAME = 'mcp_tools_read';
export const PROGRESSIVE_WRITE_TOOL_NAME = 'mcp_tools_write';
export const PROGRESSIVE_DESTRUCTIVE_TOOL_NAME = 'mcp_tools_destructive';

export type ProgressiveDispatcherName =
  | typeof PROGRESSIVE_READ_TOOL_NAME
  | typeof PROGRESSIVE_WRITE_TOOL_NAME
  | typeof PROGRESSIVE_DESTRUCTIVE_TOOL_NAME;

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'discord',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'tool',
]);

const SearchArgsSchema = z
  .object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Capability or outcome to find, for example "send a message" or "ban member".'),
    category: z
      .string()
      .max(64)
      .optional()
      .describe('Optional exact tool category. Omit query to browse this category.'),
    limit: z.number().int().min(1).max(20).default(8).describe('Maximum matches to return.'),
    detail: z
      .enum(['compact', 'full'])
      .default('compact')
      .describe(
        "compact returns short match cards. full includes every matching description and inputSchema. An exact tool-name search includes that tool's contract in either mode.",
      ),
  })
  .strict();

const DispatcherArgsSchema = z
  .object({
    tool: z.string().min(1).max(64).describe('Exact tool name returned by mcp_tools_search.'),
    args: z
      .record(z.string(), z.unknown())
      .describe('Arguments matching the inputSchema returned for that tool.'),
  })
  .strict();

const ERROR_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    retriable: { type: 'boolean' },
    category: { type: 'string', enum: ['client', 'server'] },
    recovery_hint: { type: 'string' },
  },
  required: ['code', 'retriable', 'category', 'recovery_hint'],
} as const;

export const PROGRESSIVE_SEARCH_TOOL: McpTool = {
  name: PROGRESSIVE_SEARCH_TOOL_NAME,
  description: [
    'Search the Discord tool catalog available to this caller.',
    'A single result includes its contract. For multiple compact results, search the selected exact tool name before dispatching.',
    'Set detail:"full" only when several full contracts are necessary. Omit both query and category to list categories.',
    'Search results never expand MCP_CATEGORIES permissions.',
  ].join(' '),
  inputSchema: z.toJSONSchema(SearchArgsSchema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as McpTool['inputSchema'],
  outputSchema: {
    type: 'object',
    anyOf: [
      {
        type: 'object',
        properties: {
          query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          category: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          detail: { type: 'string', enum: ['compact', 'full'] },
          total_matches: { type: 'integer' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                dispatcher: {
                  type: 'string',
                  enum: [
                    PROGRESSIVE_READ_TOOL_NAME,
                    PROGRESSIVE_WRITE_TOOL_NAME,
                    PROGRESSIVE_DESTRUCTIVE_TOOL_NAME,
                  ],
                },
                summary: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
                annotations: { type: 'object' },
              },
              required: ['name', 'category', 'dispatcher', 'summary'],
            },
          },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tool_count: { type: 'integer' },
              },
              required: ['name', 'tool_count'],
            },
          },
        },
        required: ['query', 'category', 'detail', 'total_matches', 'matches', 'categories'],
      },
      ERROR_ENVELOPE_SCHEMA,
    ],
  } as McpTool['outputSchema'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function dispatcherTool(
  name: ProgressiveDispatcherName,
  description: string,
  annotations: NonNullable<McpTool['annotations']>,
): McpTool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(DispatcherArgsSchema, {
      target: 'draft-2020-12',
      io: 'input',
    }) as McpTool['inputSchema'],
    annotations,
  };
}

export const PROGRESSIVE_DISPATCH_TOOLS: readonly McpTool[] = [
  dispatcherTool(
    PROGRESSIVE_READ_TOOL_NAME,
    'Invoke one read-only Discord tool returned by mcp_tools_search. The server rejects write or destructive tools on this dispatcher and still applies authorization, validation, resilience, and telemetry middleware.',
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  ),
  dispatcherTool(
    PROGRESSIVE_WRITE_TOOL_NAME,
    'Invoke one non-destructive write tool returned by mcp_tools_search. The server rejects read-only and destructive tools on this dispatcher and still applies all normal middleware.',
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  ),
  dispatcherTool(
    PROGRESSIVE_DESTRUCTIVE_TOOL_NAME,
    'Invoke one destructive tool returned by mcp_tools_search. Use the exact returned input schema, including __confirm:true when intended. The selected tool still requires MCP_DRY_RUN=false and passes every authorization and safety gate.',
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  ),
] as const;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeCategory(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

function scoreTool(tool: McpTool, category: string, query: string): number {
  if (query === '') return 1;

  const name = normalize(tool.name);
  const description = normalize(tool.description ?? '');
  const normalizedCategory = normalize(category);
  const terms = query.split(' ').filter((term) => term !== '' && !SEARCH_STOP_WORDS.has(term));
  let score = 0;

  if (name === query) score += 200;
  if (name.startsWith(query)) score += 80;
  if (normalizedCategory === query) score += 40;
  for (const term of terms) {
    if (name.includes(term)) score += 25;
    if (normalizedCategory.includes(term)) score += 12;
    if (description.includes(term)) score += 4;
  }
  return score;
}

function clientError(code: string, message: string, recoveryHint: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `**${code}**: ${message}` }],
    structuredContent: {
      code,
      retriable: false,
      category: 'client',
      recovery_hint: recoveryHint,
    },
  };
}

function validationError(message: string): CallToolResult {
  return clientError(
    'VALIDATION_FAILED',
    message,
    'Use the exact schema advertised for this progressive tool.',
  );
}

function dispatcherFor(tool: McpTool): ProgressiveDispatcherName {
  if (tool.annotations?.readOnlyHint === true) return PROGRESSIVE_READ_TOOL_NAME;
  if (tool.annotations?.destructiveHint === true) return PROGRESSIVE_DESTRUCTIVE_TOOL_NAME;
  return PROGRESSIVE_WRITE_TOOL_NAME;
}

function compactSummary(description: string | undefined): string {
  const firstParagraph = (description ?? '').split(/\n\s*\n/, 1)[0] ?? '';
  const normalized = firstParagraph.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

/**
 * Search only the already-authorized catalog passed by the server. This is a
 * presentation adapter for hosts without native deferred MCP loading, not an
 * authorization boundary; calls still re-enter the normal middleware chain.
 */
export function searchProgressiveTools(
  rawArgs: unknown,
  visibleTools: readonly McpTool[],
  categoriesByName: ReadonlyMap<string, string>,
): CallToolResult {
  const parsed = SearchArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }

  const query = normalize(parsed.data.query ?? '');
  const categoryFilter =
    parsed.data.category === undefined ? undefined : normalizeCategory(parsed.data.category);
  const searchable = visibleTools.filter(
    (tool) => tool.name !== 'mcp_pipeline' && tool.name !== PROGRESSIVE_SEARCH_TOOL_NAME,
  );

  const categoryCounts = new Map<string, number>();
  for (const tool of searchable) {
    const category = categoriesByName.get(tool.name);
    if (category !== undefined) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }
  const categories = [...categoryCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool_count]) => ({ name, tool_count }));

  const shouldListMatches = query !== '' || categoryFilter !== undefined;
  const ranked = shouldListMatches
    ? searchable
        .map((tool) => {
          const category = categoriesByName.get(tool.name) ?? 'unknown';
          return { tool, category, score: scoreTool(tool, category, query) };
        })
        .filter(
          ({ category, score }) =>
            (categoryFilter === undefined || category === categoryFilter) && score > 0,
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.tool.name.localeCompare(right.tool.name),
        )
    : [];

  const selected = ranked.slice(0, parsed.data.limit);
  const includeAllContracts = parsed.data.detail === 'full' || selected.length === 1;
  const matches = selected.map(({ tool, category }) => {
    const includeContract = includeAllContracts || (query !== '' && normalize(tool.name) === query);
    return {
      name: tool.name,
      category,
      dispatcher: dispatcherFor(tool),
      summary: compactSummary(tool.description),
      ...(includeContract
        ? {
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            annotations: tool.annotations ?? {},
          }
        : {}),
    };
  });

  return {
    isError: false,
    content: [
      {
        type: 'text',
        text: shouldListMatches
          ? includeAllContracts
            ? `Found ${ranked.length} matching tool(s); returned ${matches.length} full contract(s). Use each match's exact dispatcher, tool name, and input schema.`
            : `Found ${ranked.length} matching tool(s); returned ${matches.length} compact match(es). Search an exact tool name to load its input schema before dispatching.`
          : `Available categories: ${categories.map((item) => `${item.name} (${item.tool_count})`).join(', ')}.`,
      },
    ],
    structuredContent: {
      query: parsed.data.query ?? null,
      category: parsed.data.category ?? null,
      detail: parsed.data.detail,
      total_matches: ranked.length,
      matches,
      categories,
    },
  };
}

export type ProgressiveInvoke = (
  toolName: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<CallToolResult>;

/** Dispatch one discovered tool while enforcing the risk-specific route. */
export async function dispatchProgressiveTool(
  dispatcher: ProgressiveDispatcherName,
  rawArgs: unknown,
  visibleTools: readonly McpTool[],
  invoke: ProgressiveInvoke,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const parsed = DispatcherArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }

  const tool = visibleTools.find(
    (candidate) => candidate.name === parsed.data.tool && candidate.name !== 'mcp_pipeline',
  );
  if (tool === undefined) {
    return clientError(
      'TOOL_NOT_AVAILABLE',
      `Tool '${parsed.data.tool}' is not available to progressive discovery.`,
      'Search again with mcp_tools_search. Check MCP_CATEGORIES if the expected tool is absent.',
    );
  }

  const expectedDispatcher = dispatcherFor(tool);
  if (dispatcher !== expectedDispatcher) {
    return clientError(
      'DISPATCH_MODE_MISMATCH',
      `Tool '${tool.name}' must be called with '${expectedDispatcher}', not '${dispatcher}'.`,
      `Use dispatcher:'${expectedDispatcher}' from the latest mcp_tools_search result.`,
    );
  }

  return invoke(tool.name, parsed.data.args, signal);
}
